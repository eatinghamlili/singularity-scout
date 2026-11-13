// The only way to change the board. Scouts sign in here with their 4-digit code (checked on the
// server, with a lockout after repeated wrong codes) and get a signed token; every change is then
// checked against who they are before it is saved:
//   - notes are written as yourself, and only your own notes can be deleted
//   - only your own ratings can be changed
//   - the roster is for leads
//   - our team stays Team 51
// A sign-in only lasts while the scout's code stays the same: a new code signs every device out.
// Wrong codes are limited per connection, every 10 minutes and every day, so codes can't be guessed.
// Each scout can save up to 600 changes and 30 photos an hour (far more than a real event needs),
// so a lost phone or a stolen sign-in can't flood the board or fill the photo storage.
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
  [/^events\/[^/]+$/, ["season", "code", "name", "start", "end", "city", "regionCode", "type", "teamCount", "hasUs", "source", "loadedAt", "loadedBy", "live", "starred", "starredBy", "starredAt"]],
];
const TOKEN_DAYS = 45;
const LOCK_AFTER = 20, LOCK_MINUTES = 10;   // venue Wi-Fi puts the whole team behind one address
const DAY_LIMIT = 60;                        // wrong codes per connection per day: guessing a 4-digit code would take weeks
const US = 51;                               // the board is Team 51's
const HOURLY = { write: 600, upload: 30 };   // per scout
const NOTE_MAX = 2000;                       // characters in one note

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
// a sign-in remembers which code it came from (a short fingerprint, not the code); a new code ends it
const codeMark = (hash: string) => hash.slice(0, 16);
async function currentMark(sid: string) {
  const { data } = await db.from("scout_keys").select("hash").eq("id", sid).maybeSingle();
  return data?.hash ? codeMark(String(data.hash)) : null;
}
async function makeToken(sid: string, hash: string) { const body = b64u(JSON.stringify({ sid, v: codeMark(hash), exp: Date.now() + TOKEN_DAYS * 864e5 })); return body + "." + await sign(body); }
function sameText(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function readToken(tok: string | null): Promise<string | null> {
  if (!tok || !tok.includes(".")) return null;
  const [body, sig] = tok.split(".");
  if (!sameText(await sign(body), String(sig || ""))) return null;
  let sid: unknown, v: unknown, exp: unknown;
  try { ({ sid, v, exp } = JSON.parse(unb64u(body))); } catch { return null; }
  if (typeof sid !== "string" || typeof v !== "string" || !(Number(exp) > Date.now())) return null;   // older sign-ins without a fingerprint sign in again
  return (await currentMark(sid)) === v ? sid : null;
}
// per-scout hourly budget: false when this request would go over it (and then nothing is recorded)
async function withinLimit(sid: string, kind: "write" | "upload", n: number) {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { data } = await db.from("rate_log").select("n").eq("sid", sid).eq("kind", kind).gte("at", hourAgo);
  const used = (data || []).reduce((a: number, r: { n: number }) => a + (r.n || 0), 0);
  if (used + n > HOURLY[kind]) return false;
  await db.from("rate_log").insert({ sid, kind, n });
  await db.from("rate_log").delete().lt("at", new Date(Date.now() - 864e5).toISOString());   // forget yesterday
  return true;
}
const slowDown = (msg: string) => fail(429, "slow_down", msg);
async function getDoc(path: string) {
  const { data } = await db.from("docs").select("data").eq("path", path).maybeSingle();
  return (data?.data ?? null) as Record<string, any> | null;
}
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
// photos live in the public "photos" storage bucket; notes and teams may only point at those
const PHOTO_BASE = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "") + "/storage/v1/object/public/photos/";
const PHOTO_TAIL = /^events\/[0-9]{4}-[A-Z0-9]{1,30}\/(teams|matches)\/[A-Za-z0-9_-]{1,24}\/[a-z0-9]{8,24}\.(webp|jpg|png)$/;
const PHOTO_URL = { test: (u: string) => u.startsWith(PHOTO_BASE) && PHOTO_TAIL.test(u.slice(PHOTO_BASE.length)) };
// a qual note's counts: hive and flower, pollen and nectar each, for Auto and TeleOp (0-99), plus yes/no flags
const SCORED = ["hivePollen", "hiveNectar", "flowerPollen", "flowerNectar"];
const COUNT_KEYS: Record<string, { n: string[]; b: string[] }> = { a: { n: SCORED, b: ["leave", "park"] }, t: { n: SCORED, b: ["park"] } };
const PIT_STATES = ["good", "minor", "major", "down"];   // a pit visit's quick read on the robot
function badCounts(c: unknown) {
  if (!isObj(c) || Object.keys(c).some((k) => !(k in COUNT_KEYS))) return true;
  for (const [k, spec] of Object.entries(COUNT_KEYS)) {
    const v = c[k]; if (!isObj(v)) return true;
    if (Object.keys(v).some((f) => !spec.n.includes(f) && !spec.b.includes(f))) return true;
    if (spec.n.some((f) => !Number.isInteger(v[f]) || v[f] < 0 || v[f] > 99)) return true;
    if (spec.b.some((f) => typeof v[f] !== "boolean")) return true;
  }
  return false;
}
// every field the board saves has a type; anything else is refused, so nothing odd can reach teammates' screens
const RATING_KEYS = ["auto", "teleop", "endgame", "driving", "reliability", "defense"];
const NOTE_FIELDS = ["by", "text", "at", "changed", "ctx", "match", "counts", "state", "nums", "photos"];
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const numOrNull = (v: unknown) => v === null || isNum(v);
const isTime = (v: unknown) => isNum(v) && (v as number) > 0 && (v as number) < 4102444800000;   // a date before 2100
function badNums(v: unknown, max = 10) {
  return !isObj(v) || Object.entries(v).some(([k, x]) => !RATING_KEYS.includes(k) || !Number.isInteger(x) || (x as number) < 0 || (x as number) > max);
}
function badStats(v: unknown) {   // a team's results from FTCScout/FIRST: a flat list of numbers
  return v !== null && (!isObj(v) || Object.keys(v).length > 20 || Object.values(v).some((x) => !numOrNull(x)));
}
function checkTeamFields(d: Record<string, any>, uid: string) {
  if ("number" in d && !(Number.isInteger(d.number) && d.number > 0 && d.number < 1e6)) return "That team number isn't valid.";
  for (const f of ["name", "city"]) if (f in d && !isStr(d[f], 120)) return "Team names and cities are 120 letters at most.";
  if ("status" in d && !["available", "taken", "partner"].includes(d.status)) return "That pick status isn't valid.";
  if ("dnp" in d && typeof d.dnp !== "boolean") return "Do-not-pick is yes or no.";
  if ("tags" in d && !(Array.isArray(d.tags) && d.tags.length <= 30 && d.tags.every((t: unknown) => isStr(t, 40)))) return "Tags are short words (30 at most).";
  if ("ev" in d && badStats(d.ev)) return "Those results couldn't be saved.";
  if ("season" in d && badStats(d.season)) return "Those results couldn't be saved.";
  if ("loadedAt" in d && !isTime(d.loadedAt)) return "That time isn't valid.";
  if ("mobility" in d && d.mobility !== null && !(isObj(d.mobility) && typeof d.mobility.ok === "boolean" && d.mobility.by === uid && isTime(d.mobility.at) && Object.keys(d.mobility).length === 3)) return "Can-it-move is saved under your own name.";
  if ("aiRecap" in d && d.aiRecap !== null) return "AI overviews are switched off.";
  if (d.ratings !== undefined && isObj(d.ratings)) {
    for (const r of Object.values(d.ratings)) {
      if (r === null) continue;
      if (!isObj(r)) return "Ratings must be numbers.";
      const { scale, at, ...cats } = r as Record<string, unknown>;
      if (badNums(cats) || (scale !== undefined && scale !== 10) || (at !== undefined && !isTime(at))) return "Ratings are whole numbers from 1 to 10.";
    }
  }
  return null;
}
function checkEventFields(d: Record<string, any>, uid: string) {
  for (const f of ["code", "regionCode", "type", "source", "start", "end"]) if (f in d && d[f] !== null && !isStr(d[f], 40)) return "That competition detail isn't valid.";
  for (const f of ["name", "city"]) if (f in d && d[f] !== null && !isStr(d[f], 160)) return "That competition detail isn't valid.";
  for (const f of ["season", "teamCount"]) if (f in d && !(Number.isInteger(d[f]) && d[f] >= 0 && d[f] < 10000)) return "That competition detail isn't valid.";
  for (const f of ["hasUs", "starred"]) if (f in d && typeof d[f] !== "boolean") return "That competition detail isn't valid.";
  for (const f of ["loadedAt", "starredAt"]) if (f in d && !isTime(d[f])) return "That time isn't valid.";
  for (const f of ["loadedBy", "starredBy"]) if (f in d && d[f] !== null && d[f] !== uid) return "Saved under your own name only.";
  if ("live" in d) {
    const l = d.live;
    if (!isObj(l) || Object.keys(l).some((k) => !["on", "every", "at", "by", "changed", "added"].includes(k)) || typeof l.on !== "boolean"
      || (l.every !== undefined && !(isNum(l.every) && l.every >= 0 && l.every <= 1440)) || (l.at !== undefined && !isTime(l.at))
      || (l.by !== undefined && l.by !== null && l.by !== uid) || (l.changed !== undefined && !numOrNull(l.changed)) || (l.added !== undefined && !numOrNull(l.added)))
      return "That live-update setting isn't valid.";
  }
  return null;
}
const okPhotos = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 6 && v.every((u) => typeof u === "string" && PHOTO_URL.test(u)));

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
    if (Object.keys(v).some((k) => !NOTE_FIELDS.includes(k))) return "That note has a field the board doesn't use.";
    if (v.at !== undefined && !isTime(v.at)) return "That note's time isn't valid.";
    if (v.changed !== undefined && typeof v.changed !== "boolean") return "That note couldn't be saved.";
    if (v.nums !== undefined && badNums(v.nums)) return "Numbers are whole numbers from 1 to 10.";
    if (v.text !== undefined && (typeof v.text !== "string" || v.text.length > NOTE_MAX)) return `Notes are ${NOTE_MAX.toLocaleString("en-US")} characters at most.`;
    if (!okPhotos(v.photos)) return "Photos must be uploaded through the board.";
    if (v.ctx !== undefined && v.ctx !== "qual" && v.ctx !== "pit") return "Pick where the note is from: a qual or the pits.";
    if (v.match !== undefined && (typeof v.match !== "string" || !/^[A-Za-z]{1,8}-[0-9]{1,3}-[0-9]{1,4}$/.test(v.match))) return "That qual isn't on the schedule.";
    if (v.counts !== undefined && badCounts(v.counts)) return "Those counts couldn't be saved.";
    if (v.state !== undefined && !PIT_STATES.includes(v.state)) return "Pick the robot's condition.";
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
  const { count: today } = await db.from("auth_attempts").select("*", { count: "exact", head: true }).eq("ip", ip).gte("at", new Date(Date.now() - 864e5).toISOString());
  if ((today ?? 0) >= DAY_LIMIT) return fail(429, "locked", "Too many wrong codes from this connection today. Ask a lead for your code, or try again tomorrow.");
  const code = String(body?.code || "");
  if (!/^\d{4,6}$/.test(code)) return fail(400, "bad_code", "Codes are 4 digits.");
  const hash = await sha256("singularity51:" + code);
  const { data } = await db.from("scout_keys").select("id").eq("hash", hash).maybeSingle();
  const scout = data ? await getDoc(`scouts/${data.id}`) : null;
  if (!data || !scout) {
    await db.from("auth_attempts").insert({ ip });
    await db.from("auth_attempts").delete().lt("at", new Date(Date.now() - 864e5).toISOString());   // forget old attempts
    return fail(401, "wrong_code", "That code doesn't match anyone on Team 51's roster. Ask a lead if you've forgotten yours.");
  }
  return json({ id: data.id, name: scout.name, lead: !!scout.lead, token: await makeToken(data.id, hash) });
}

// a photo for a team or match: the page shrinks it first, so it arrives small (a few hundred KB)
async function upload(req: Request, body: any) {
  const me = await readToken(req.headers.get("x-scout-token"));
  if (!me || !(await getDoc(`scouts/${me}`))) return fail(401, "signin", "Sign in with your scout code to add photos.");
  if (!(await withinLimit(me, "upload", 1))) return slowDown("That's a lot of photos in one hour. Try again in a little while.");
  const doc = String(body?.path || "");
  if (!/^events\/[0-9]{4}-[A-Z0-9]{1,30}\/(teams|matches)\/[A-Za-z0-9_-]{1,24}$/.test(doc)) return fail(400, "bad_path", "Photos go on a team or a match.");
  const type = String(body?.type || ""), ext = ({ "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" } as Record<string, string>)[type];
  if (!ext) return fail(400, "bad_type", "That kind of picture isn't supported.");
  let bytes: Uint8Array;
  try { const bin = atob(String(body?.data || "")); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
  catch { return fail(400, "bad_data", "That picture couldn't be read."); }
  if (bytes.length < 100 || bytes.length > 2_000_000) return fail(400, "too_big", "That picture is too large.");
  const name = `${doc}/${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}.${ext}`;
  const { error } = await db.storage.from("photos").upload(name, bytes, { contentType: type, upsert: false });
  if (error) return fail(500, "server", "The photo couldn't be saved. Try again.");
  return json({ url: PHOTO_BASE + name });
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
    if (path.startsWith("requests/")) {
      const cur = await getDoc(path);
      if (cur && !lead && cur.by !== uid) return "Only the scout who asked, or a lead, can remove a request.";
      await db.from("docs").delete().eq("path", path); return null;
    }
    if (path.startsWith("scouts/")) {
      if (!lead) return "Only leads can change the roster.";
      if (path === `scouts/${me}`) return "You can't remove yourself.";
      await db.from("scout_keys").delete().eq("id", path.slice(7));
      await db.from("docs").delete().eq("path", path); return null;
    }
    return "Competitions, teams and matches can't be deleted.";
  }

  const shape = checkShape(path, data); if (shape) return shape;
  if (path === "settings/main") {
    if ("us" in data && Number(data.us) !== US) return `This board is for Team ${US}.`;
    if (kind === "upsert") data = { ...data, us: US };
    if ("size" in data && ![2, 3].includes(data.size)) return "Alliances are 2 or 3 teams.";
    if ("event" in data && data.event !== null && !(typeof data.event === "string" && /^[0-9]{4}-[A-Z0-9]{1,30}$/.test(data.event))) return "That competition isn't valid.";
    if ("weights" in data && (!isObj(data.weights) || Object.entries(data.weights).some(([k, v]) => !["auto", "teleop", "endgame", "fouls", "scout"].includes(k) || !isNum(v) || (v as number) < 0 || (v as number) > 2))) return "Those weights couldn't be saved.";
  }
  if (path.startsWith("scouts/") && !lead && !firstLead) return "Only leads can change the roster.";
  if (path.startsWith("requests/")) {
    if ("by" in data && data.by !== null && data.by !== uid) return "Requests are saved under your own name.";
    if ("season" in data && !(Number.isInteger(data.season) && data.season > 2000 && data.season < 2100)) return "That season isn't valid.";
    if ("code" in data && !(typeof data.code === "string" && /^[A-Z0-9]{1,30}$/.test(data.code))) return "That competition code isn't valid.";
    if ("status" in data && !["waiting", "failed"].includes(data.status)) return "That request status isn't valid.";
    if ("error" in data && !isStr(data.error, 300)) return "That message is too long.";
    if ("at" in data && !isTime(data.at)) return "That time isn't valid.";
  }
  if (/^events\/[^/]+$/.test(path)) { const e = checkEventFields(data, uid); if (e) return e; }

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
    if ("name" in data && !(typeof data.name === "string" && data.name.trim() && data.name.length <= 40)) return "Names are 1 to 40 letters.";
    if ("lead" in data && typeof data.lead !== "boolean") return "Lead is yes or no.";
    if ("createdAt" in data && !isTime(data.createdAt)) return "That time isn't valid.";
    if (data.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(data.color))) return "That color isn't allowed.";
  }

  if (/\/(teams|matches)\//.test(path)) {
    const cur = await getDoc(path);
    const n = checkNotes(data.notes, cur?.notes, uid); if (n) return n;
    if (path.includes("/teams/")) { const tf = checkTeamFields(data, uid); if (tf) return tf; }
    if ("label" in data && !isStr(data.label, 20)) return "That match label isn't valid.";
    if (data.ratings !== undefined) {
      if (!isObj(data.ratings)) return "Ratings must be an object.";
      const others = Object.keys(data.ratings).filter((k) => k !== uid);
      if (others.length) return "You can only change your own ratings.";
    }
    if (data.photo !== undefined && data.photo !== null) {
      if (!isObj(data.photo) || typeof data.photo.url !== "string" || !PHOTO_URL.test(data.photo.url)) return "Photos must be uploaded through the board.";
      data = { ...data, photo: { url: data.photo.url, by: uid, at: Date.now() } };   // stamped with who chose it
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
    if (body?.action === "upload") return await upload(req, body);
    if (body?.action !== "write" || !Array.isArray(body.ops) || !body.ops.length || body.ops.length > 50) return fail(400, "bad_request", "Unknown request.");
    const me = await readToken(req.headers.get("x-scout-token"));
    const meDoc = me ? await getDoc(`scouts/${me}`) : null;
    if (me && !meDoc) return fail(401, "signin", "Your scout code was removed. Sign in again.");
    if (me && !(await withinLimit(me, "write", body.ops.length))) return slowDown("That's a lot of changes in one hour. They're kept on this phone and will go through shortly.");
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
