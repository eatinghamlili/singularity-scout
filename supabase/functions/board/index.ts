// The only way to change the board. Scouts sign in here with their 4-digit code (checked on the
// server, with a lockout after repeated wrong codes) and get a signed token; every change is then
// checked against who they are before it is saved:
//   - notes are written as yourself, and only your own notes can be deleted
//   - only your own ratings can be changed
//   - the roster is for leads
// The database refuses writes from anywhere else, so the page can't be bypassed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-scout-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string) => json({ error: code, message }, status);

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const PATH = /^(settings\/main|scouts\/[A-Za-z0-9_-]{1,40}|requests\/[0-9]{4}-[A-Z0-9]{1,30}|events\/[0-9]{4}-[A-Z0-9]{1,30}|events\/[0-9]{4}-[A-Z0-9]{1,30}\/teams\/[0-9]{1,6}|events\/[0-9]{4}-[A-Z0-9]{1,30}\/matches\/[A-Za-z0-9_-]{1,24})$/;
const KEYS: [RegExp, string[] | null][] = [
  [/^settings\/main$/, ["us", "event", "size", "weights"]],
  [/^scouts\//, ["name", "lead", "color", "createdAt", "hash"]],
  [/^requests\//, ["season", "code", "by", "at", "status", "error"]],
  [/\/teams\//, ["number", "name", "city", "ev", "season", "loadedAt", "status", "dnp", "tags", "ratings", "notes", "aiRecap", "mobility", "photo"]],
  [/\/matches\//, ["label", "notes"]],
  [/^events\/[^/]+$/, null],
];
const TOKEN_DAYS = 45;
const LOCK_AFTER = 20, LOCK_MINUTES = 10;   // venue Wi-Fi puts the whole team behind one address

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
let keyPromise: Promise<CryptoKey> | null = null;
function hmacKey() {
  keyPromise ??= (async () => {
    const { data, error } = await db.from("app_secrets").select("value").eq("name", "token_key").single();
    if (error || !data) throw new Error("token key missing");
    return crypto.subtle.importKey("raw", enc.encode(data.value), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  })();
  return keyPromise;
}
const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
async function sign(body: string) { return hex(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body))); }
async function makeToken(sid: string) { const body = b64u(JSON.stringify({ sid, exp: Date.now() + TOKEN_DAYS * 864e5 })); return body + "." + await sign(body); }
async function readToken(tok: string | null): Promise<string | null> {
  if (!tok || !tok.includes(".")) return null;
  const [body, sig] = tok.split(".");
  if ((await sign(body)) !== sig) return null;
  try { const { sid, exp } = JSON.parse(unb64u(body)); return typeof sid === "string" && exp > Date.now() ? sid : null; } catch { return null; }
}
async function getDoc(path: string) {
  const { data } = await db.from("docs").select("data").eq("path", path).maybeSingle();
  return (data?.data ?? null) as Record<string, any> | null;
}
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

// ---- what a scout may change ----
function checkShape(path: string, data: any) {
  if (!isObj(data)) return "Changes must be an object.";
  if (JSON.stringify(data).length > 150_000) return "That change is too large.";
  const rule = KEYS.find(([re]) => re.test(path));
  if (rule && rule[1]) { const bad = Object.keys(data).filter((k) => !rule[1]!.includes(k)); if (bad.length) return `Unexpected field: ${bad[0]}.`; }
  return null;
}
function checkNotes(notes: unknown, existing: Record<string, any> | undefined, me: string) {
  if (notes === undefined) return null;
  if (!isObj(notes)) return "Notes must be an object.";
  for (const [id, v] of Object.entries(notes)) {
    const old = existing?.[id];
    if (v === null) { if (old && old.by !== me) return "You can only delete your own notes."; continue; }
    if (!isObj(v)) return "A note must be an object.";
    if (old && old.by !== me) return "You can only edit your own notes.";
    if (!old && v.by !== me) return "Notes are saved under your own name.";
    if (old && v.by !== undefined && v.by !== me) return "Notes are saved under your own name.";
  }
  return null;
}

async function signIn(req: Request, body: any) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
  const { count } = await db.from("auth_attempts").select("*", { count: "exact", head: true }).eq("ip", ip).gte("at", since);
  if ((count ?? 0) >= LOCK_AFTER) return fail(429, "locked", `Too many wrong codes. Try again in ${LOCK_MINUTES} minutes.`);
  const code = String(body?.code || "");
  if (!/^\d{4,6}$/.test(code)) return fail(400, "bad_code", "Codes are 4 digits.");
  const { data } = await db.from("scout_keys").select("id").eq("hash", await sha256("singularity51:" + code)).maybeSingle();
  const scout = data ? await getDoc(`scouts/${data.id}`) : null;
  if (!data || !scout) {
    await db.from("auth_attempts").insert({ ip });
    await db.from("auth_attempts").delete().lt("at", new Date(Date.now() - 864e5).toISOString());   // forget old attempts
    return fail(401, "wrong_code", "That code doesn't match anyone on Team 51's roster. Ask a lead if you've forgotten yours.");
  }
  return json({ id: data.id, name: scout.name, lead: !!scout.lead, token: await makeToken(data.id) });
}

async function applyOp(op: any, me: string | null, meDoc: Record<string, any> | null, rosterEmpty: boolean) {
  const kind = op?.kind, path = String(op?.path || "");
  let data = op?.data;
  if (!PATH.test(path)) return "That record isn't part of the board.";
  if (!["merge", "upsert", "delete"].includes(kind)) return "Unknown change.";
  const lead = !!meDoc?.lead;
  const firstLead = rosterEmpty && path.startsWith("scouts/") && kind !== "delete" && isObj(data) && data.lead === true;
  if (!me && !firstLead) return "signin";
  const uid = me ? "s_" + me : "";

  if (kind === "delete") {
    if (path.startsWith("requests/")) { await db.from("docs").delete().eq("path", path); return null; }
    if (path.startsWith("scouts/")) {
      if (!lead) return "Only leads can change the roster.";
      if (path === `scouts/${me}`) return "You can't remove yourself.";
      await db.from("scout_keys").delete().eq("id", path.slice(7));
      await db.from("docs").delete().eq("path", path); return null;
    }
    return "Competitions, teams and matches can't be deleted.";
  }

  const shape = checkShape(path, data); if (shape) return shape;
  if (path.startsWith("scouts/") && !lead && !firstLead) return "Only leads can change the roster.";

  if (path.startsWith("scouts/")) {
    // a code arrives already scrambled; keep it in the private table, never on the public record
    if ("hash" in data) {
      const h = String(data.hash || "");
      if (!/^[0-9a-f]{64}$/.test(h)) return "That code couldn't be saved.";
      const { data: other } = await db.from("scout_keys").select("id").eq("hash", h).maybeSingle();
      if (other && other.id !== path.slice(7)) return "Someone already has that code. Pick another.";
      const { error } = await db.from("scout_keys").upsert({ id: path.slice(7), hash: h, updated_at: new Date().toISOString() });
      if (error) return "That code couldn't be saved.";
      data = { ...data }; delete data.hash;
    }
    if (typeof data.name === "string" && data.name.length > 40) return "Names are 40 letters at most.";
    if (data.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(data.color))) return "That color isn't allowed.";
  }

  if (/\/(teams|matches)\//.test(path)) {
    const cur = await getDoc(path);
    const n = checkNotes(data.notes, cur?.notes, uid); if (n) return n;
    if (data.ratings !== undefined) {
      if (!isObj(data.ratings)) return "Ratings must be an object.";
      const others = Object.keys(data.ratings).filter((k) => k !== uid);
      if (others.length) return "You can only change your own ratings.";
    }
    if (kind === "upsert") return "Teams and matches are only ever merged into."; // never replaced wholesale
  }

  if (kind === "merge" || path.startsWith("events/")) {
    const { error } = await db.rpc("merge_doc", { p_path: path, p_patch: data });
    if (error) return "Couldn't save that change.";
  } else {
    const { error } = await db.from("docs").upsert({ path, data, updated_at: new Date().toISOString() });
    if (error) return "Couldn't save that change.";
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "method", "Use POST.");
  let body: any = null; try { body = await req.json(); } catch { /* empty */ }
  try {
    if (body?.action === "signin") return await signIn(req, body);
    if (body?.action !== "write" || !Array.isArray(body.ops) || !body.ops.length || body.ops.length > 50) return fail(400, "bad_request", "Unknown request.");
    const me = await readToken(req.headers.get("x-scout-token"));
    const meDoc = me ? await getDoc(`scouts/${me}`) : null;
    if (me && !meDoc) return fail(401, "signin", "Your scout code was removed. Sign in again.");
    const { count } = await db.from("scout_keys").select("*", { count: "exact", head: true });
    const results: (string | null)[] = [];
    for (const op of body.ops) {
      const err = await applyOp(op, meDoc ? me : null, meDoc, (count ?? 0) === 0);
      if (err === "signin") return fail(401, "signin", "Sign in with your scout code to make changes.");
      results.push(err);
    }
    const refused = results.find((r) => r);
    return refused ? json({ ok: false, error: "refused", message: refused, results }, 403) : json({ ok: true });
  } catch (e) {
    return fail(500, "server", "Something went wrong saving that. Try again.");
  }
});
