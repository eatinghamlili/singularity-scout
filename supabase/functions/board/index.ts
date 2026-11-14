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
// Scouts can also make an account with a username and password (no email, nothing linked). An account starts
// from the 4-digit code a lead handed out, so nobody can make one without a code; the same code later sets a new
// password if one is forgotten. Passwords are stored only as salted PBKDF2 hashes in a private table, and a
// lead can also hand out a one-time temporary password. Each scout picks whether teammates see their roster
// name or their username.
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
  [/^scouts\//, ["name", "lead", "color", "createdAt", "hash", "pending"]],
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
  if (data?.hash) return codeMark(String(data.hash));
  const { data: l } = await db.from("scout_logins").select("pass_hash").eq("id", sid).maybeSingle();
  return l?.pass_hash ? "p" + String(l.pass_hash).slice(0, 15) : null;   // a new password signs other phones out
}
async function makeToken(sid: string, mark: string) { const body = b64u(JSON.stringify({ sid, v: mark, exp: Date.now() + TOKEN_DAYS * 864e5 })); return body + "." + await sign(body); }
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

const ipOf = (req: Request) => (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
// wrong codes and wrong passwords count together, per connection
async function lockedOut(ip: string) {
  const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
  const { count } = await db.from("auth_attempts").select("*", { count: "exact", head: true }).eq("ip", ip).gte("at", since);
  if ((count ?? 0) >= LOCK_AFTER) return fail(429, "locked", `Too many wrong tries. Try again in ${LOCK_MINUTES} minutes.`);
  const { count: today } = await db.from("auth_attempts").select("*", { count: "exact", head: true }).eq("ip", ip).gte("at", new Date(Date.now() - 864e5).toISOString());
  if ((today ?? 0) >= DAY_LIMIT) return fail(429, "locked", "Too many wrong tries from this connection today. Ask a lead for help, or try again tomorrow.");
  return null;
}
async function recordFail(ip: string) {
  await db.from("auth_attempts").insert({ ip });
  await db.from("auth_attempts").delete().lt("at", new Date(Date.now() - 864e5).toISOString());   // forget old attempts
}

// ---- usernames and passwords ----
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,23}$/;
const PW_MIN = 8, PW_MAX = 128, PBKDF2_ITERS = 150_000;
const fromHex = (h: string) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
async function hashPassword(pw: string, saltHex?: string, iters = PBKDF2_ITERS) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iters }, key, 256);
  return { hash: hex(bits), salt: hex(salt.buffer), iters };
}
const pwProblem = (pw: string) => pw.length < PW_MIN ? `Passwords are at least ${PW_MIN} characters.` : pw.length > PW_MAX ? "That password is too long." : null;
const wrongLogin = () => fail(401, "wrong_login", "That username and password don't match. Ask a lead if you've forgotten your password.");
async function logIn(req: Request, body: any) {
  const ip = ipOf(req);
  const locked = await lockedOut(ip); if (locked) return locked;
  const username = String(body?.username || "").trim().toLowerCase(), pw = String(body?.password || "");
  if (!USERNAME.test(username) || !pw || pw.length > PW_MAX) { await recordFail(ip); return wrongLogin(); }
  const { data: l } = await db.from("scout_logins").select("id, pass_hash, salt, iters, must_change").eq("username", username).maybeSingle();
  const h = await hashPassword(pw, l?.salt || "00".repeat(16), l?.iters || PBKDF2_ITERS);   // same work either way, so timing doesn't tell
  if (!l || !sameText(h.hash, String(l.pass_hash))) { await recordFail(ip); return wrongLogin(); }
  const scout = await getDoc(`scouts/${l.id}`);
  if (!scout) { await recordFail(ip); return wrongLogin(); }
  if (scout.pending) return fail(403, "pending", "Your account is waiting for a lead to approve it in the Team roster.");
  const mark = await currentMark(l.id);
  if (!mark) return wrongLogin();
  return json({ id: l.id, name: scout.name, lead: !!scout.lead, token: await makeToken(l.id, mark), mustChange: !!l.must_change });
}
// a signed-in scout picks a new password (or, signed in with a code, adds a username and password)
async function changePassword(req: Request, body: any) {
  const me = await readToken(req.headers.get("x-scout-token"));
  const meDoc = me ? await getDoc(`scouts/${me}`) : null;
  if (!me || !meDoc || meDoc.pending) return fail(401, "signin", "Sign in again first.");
  const pw = String(body?.password || ""), cur = String(body?.current || "");
  const bad = pwProblem(pw); if (bad) return fail(400, "bad_password", bad);
  const { data: l } = await db.from("scout_logins").select("id, pass_hash, salt, iters, must_change").eq("id", me).maybeSingle();
  if (l && !l.must_change) {
    const ip = ipOf(req);
    const locked = await lockedOut(ip); if (locked) return locked;
    const h0 = await hashPassword(cur, l.salt, l.iters);
    let ok = sameText(h0.hash, String(l.pass_hash));
    if (!ok && /^\d{4,6}$/.test(cur)) { const { data: k } = await db.from("scout_keys").select("id").eq("hash", await sha256("singularity51:" + cur)).maybeSingle(); ok = !!k && k.id === me; }
    if (!ok) { await recordFail(ip); return fail(401, "wrong_password", "That isn't your current password or your code."); }
  }
  const h = await hashPassword(pw);
  if (l) {
    const { error } = await db.from("scout_logins").update({ pass_hash: h.hash, salt: h.salt, iters: h.iters, must_change: false, updated_at: new Date().toISOString() }).eq("id", me);
    if (error) return fail(500, "server", "The password couldn't be saved. Try again.");
  } else {
    const username = String(body?.username || "").trim().toLowerCase();
    if (!USERNAME.test(username)) return fail(400, "bad_username", "Usernames are 3 to 24 letters or numbers (dots, dashes and underscores are OK).");
    const { data: taken } = await db.from("scout_logins").select("id").eq("username", username).maybeSingle();
    if (taken) return fail(409, "taken", "That username is taken. Pick another.");
    const { error } = await db.from("scout_logins").insert({ id: me, username, pass_hash: h.hash, salt: h.salt, iters: h.iters, created_ip: ipOf(req) });
    if (error) return fail(409, "taken", "That username is taken. Pick another.");
    await db.rpc("merge_doc", { p_path: `scouts/${me}`, p_patch: { login: true } });
    await setDisplay(me, body?.display ?? meDoc.display ?? "name", username);
  }
  const mark = await currentMark(me);
  return json({ ok: true, token: mark ? await makeToken(me, mark) : null });
}
// leads: see usernames, and hand out a one-time temporary password
async function leadOnly(req: Request) {
  const me = await readToken(req.headers.get("x-scout-token"));
  const meDoc = me ? await getDoc(`scouts/${me}`) : null;
  return me && meDoc && meDoc.lead && !meDoc.pending ? me : null;
}
async function listLogins(req: Request) {
  if (!(await leadOnly(req))) return fail(403, "lead", "Only leads can see usernames.");
  const { data } = await db.from("scout_logins").select("id, username, must_change");
  return json({ logins: (data || []).map((r: any) => ({ id: r.id, username: r.username, mustChange: !!r.must_change })) });
}
async function resetPassword(req: Request, body: any) {
  if (!(await leadOnly(req))) return fail(403, "lead", "Only leads can reset passwords.");
  const id = String(body?.id || "");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return fail(400, "bad_id", "Pick a scout.");
  const { data: l } = await db.from("scout_logins").select("id, username").eq("id", id).maybeSingle();
  if (!l) return fail(404, "no_login", "That scout signs in with a code, not a password.");
  const abc = "abcdefghjkmnpqrstuvwxyz23456789", r = crypto.getRandomValues(new Uint8Array(10));
  const temp = [...r].map((b) => abc[b % abc.length]).join("");
  const h = await hashPassword(temp);
  const { error } = await db.from("scout_logins").update({ pass_hash: h.hash, salt: h.salt, iters: h.iters, must_change: true, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return fail(500, "server", "The password couldn't be reset. Try again.");
  return json({ ok: true, username: l.username, temp });
}

// a scout's 4-digit code: who it belongs to (wrong codes count toward the lockout)
async function codeOwner(ip: string, code: string) {
  if (!/^\d{4,6}$/.test(code)) return { err: fail(400, "bad_code", "Codes are 4 digits.") };
  const hash = await sha256("singularity51:" + code);
  const { data } = await db.from("scout_keys").select("id").eq("hash", hash).maybeSingle();
  const scout = data ? await getDoc(`scouts/${data.id}`) : null;
  if (!data || !scout) { await recordFail(ip); return { err: fail(401, "wrong_code", "That code doesn't match anyone on Team 51's roster. Ask a lead if you've forgotten yours.") }; }
  return { id: String(data.id), scout, hash };
}
async function signIn(req: Request, body: any) {
  const ip = ipOf(req);
  const locked = await lockedOut(ip); if (locked) return locked;
  const o = await codeOwner(ip, String(body?.code || "")); if (o.err) return o.err;
  return json({ id: o.id, name: o.scout!.name, lead: !!o.scout!.lead, token: await makeToken(o.id, codeMark(o.hash!)) });
}
// what teammates see: the roster name, or the username (only published when the scout picks it)
async function setDisplay(id: string, display: unknown, username: string) {
  const d = display === "username" ? "username" : display === "name" ? "name" : null;
  if (!d) return;
  await db.rpc("merge_doc", { p_path: `scouts/${id}`, p_patch: { display: d, handle: d === "username" ? username : null } });
}
// with your code: make your account (username + password), or set a new password / username if you forgot
async function claim(req: Request, body: any) {
  const ip = ipOf(req);
  const locked = await lockedOut(ip); if (locked) return locked;
  const o = await codeOwner(ip, String(body?.code || "")); if (o.err) return o.err;
  const pw = String(body?.password || ""), want = String(body?.username || "").trim().toLowerCase();
  const bad = pwProblem(pw); if (bad) return fail(400, "bad_password", bad);
  const { data: l } = await db.from("scout_logins").select("id, username").eq("id", o.id).maybeSingle();
  const username = want || l?.username || "";
  if (!USERNAME.test(username)) return fail(400, "bad_username", "Usernames are 3 to 24 letters or numbers (dots, dashes and underscores are OK).");
  if (!l || username !== l.username) {
    const { data: taken } = await db.from("scout_logins").select("id").eq("username", username).maybeSingle();
    if (taken && taken.id !== o.id) return fail(409, "taken", "That username is taken. Pick another.");
  }
  const h = await hashPassword(pw), now = new Date().toISOString();
  const { error } = l
    ? await db.from("scout_logins").update({ username, pass_hash: h.hash, salt: h.salt, iters: h.iters, must_change: false, updated_at: now }).eq("id", o.id)
    : await db.from("scout_logins").insert({ id: o.id, username, pass_hash: h.hash, salt: h.salt, iters: h.iters, created_ip: ip });
  if (error) return fail(409, "taken", "That username is taken. Pick another.");
  await db.rpc("merge_doc", { p_path: `scouts/${o.id}`, p_patch: { login: true, pending: false } });
  const cur = o.scout!.display === "username" ? "username" : "name";
  await setDisplay(o.id, body?.display ?? cur, username);
  return json({ id: o.id, name: o.scout!.name, lead: !!o.scout!.lead, username, token: await makeToken(o.id, codeMark(o.hash!)) });
}
// a signed-in scout switches between showing their roster name and their username
async function display(req: Request, body: any) {
  const me = await readToken(req.headers.get("x-scout-token"));
  const meDoc = me ? await getDoc(`scouts/${me}`) : null;
  if (!me || !meDoc || meDoc.pending) return fail(401, "signin", "Sign in again first.");
  const { data: l } = await db.from("scout_logins").select("username").eq("id", me).maybeSingle();
  if (body?.display === "username" && !l) return fail(400, "no_login", "Make a username first.");
  await setDisplay(me, body?.display, l?.username || "");
  return json({ ok: true });
}

// a photo for a team or match: the page shrinks it first, so it arrives small (a few hundred KB)
async function upload(req: Request, body: any) {
  const me = await readToken(req.headers.get("x-scout-token"));
  const meDoc = me ? await getDoc(`scouts/${me}`) : null;
  if (!me || !meDoc || meDoc.pending) return fail(401, "signin", "Sign in with your scout code to add photos.");
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
      await db.from("scout_logins").delete().eq("id", path.slice(7));
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
    if ("pending" in data && data.pending !== false) return "Leads approve accounts; they can't be un-approved.";
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
    if (body?.action === "signup") return fail(410, "need_code", "Ask a lead for a 4-digit code, then use it to make your account.");
    if (body?.action === "claim") return await claim(req, body);
    if (body?.action === "display") return await display(req, body);
    if (body?.action === "login") return await logIn(req, body);
    if (body?.action === "password") return await changePassword(req, body);
    if (body?.action === "logins") return await listLogins(req);
    if (body?.action === "resetpw") return await resetPassword(req, body);
    if (body?.action !== "write" || !Array.isArray(body.ops) || !body.ops.length || body.ops.length > 50) return fail(400, "bad_request", "Unknown request.");
    const me = await readToken(req.headers.get("x-scout-token"));
    const meDoc = me ? await getDoc(`scouts/${me}`) : null;
    if (me && !meDoc) return fail(401, "signin", "Your scout code was removed. Sign in again.");
    if (me && meDoc?.pending) return fail(401, "signin", "Your account is waiting for a lead to approve it.");
    if (me && !(await withinLimit(me, "write", body.ops.length))) return slowDown("That's a lot of changes in one hour. They're kept on this phone and will go through shortly.");
    const { count } = await db.from("docs").select("*", { count: "exact", head: true }).like("path", "scouts/%");   // code and password scouts both count
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
