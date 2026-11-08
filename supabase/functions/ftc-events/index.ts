// Read-only window onto FIRST's official FTC Events API.
//
// The browser asks for one of a few public lists (an event, its teams, rankings or match
// schedule/results); this function adds the team's FIRST API login and passes the answer back.
// The login never leaves Supabase, and only the lists below can be requested, so the key
// can't be used for anything else. Answers are cached for a minute to stay well inside
// FIRST's rate limits when many scouts have the board open.
//
// Needs the key as a Supabase secret (dashboard -> Edge Functions -> Secrets), e.g. first_key.
// The FIRST username defaults to the account the key was issued to; FTC_API_USERNAME overrides it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const API = "https://ftc-api.firstinspires.org/v2.0/";
const CODE = "[A-Za-z0-9]{1,30}";
// the only requests allowed through
const ALLOWED = [
  new RegExp(`^\\d{4}/events\\?eventCode=${CODE}$`),
  new RegExp(`^\\d{4}/teams\\?eventCode=${CODE}(&page=\\d{1,3})?$`),
  new RegExp(`^\\d{4}/rankings/${CODE}$`),
  new RegExp(`^\\d{4}/schedule/${CODE}/(qual|playoff)/hybrid$`),
];
// The key is the long dashed code FIRST emails; find it in whichever of these secrets holds it.
// The username is the FIRST account it was issued to (FTC_API_USERNAME when that holds a name).
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_USER = "eathamlili";
function login() {
  const vals = ["first_key", "FTC_API_KEY", "FTC_API_USERNAME", "eathamlili"].map((n) => (Deno.env.get(n) || "").trim()).filter(Boolean);
  const key = vals.find((v) => GUID.test(v)) || "";
  const named = (Deno.env.get("FTC_API_USERNAME") || "").trim();
  return { key, user: named && !GUID.test(named) ? named : DEFAULT_USER };
}
const TTL = 60_000;
const cache = new Map<string, { at: number; status: number; body: string }>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const { user, key } = login();
  if (!key) return json({ error: "The FIRST API key isn't set up yet." }, 503);

  let path = "";
  try { path = String((await req.json())?.path || ""); } catch { /* fall through */ }
  if (!ALLOWED.some((r) => r.test(path))) return json({ error: "That request isn't allowed." }, 400);

  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return new Response(hit.body, { status: hit.status, headers: { ...CORS, "Content-Type": "application/json", "X-Cache": "hit" } });

  let res: Response;
  try {
    res = await fetch(API + path, { headers: { Authorization: "Basic " + btoa(`${user}:${key}`), Accept: "application/json" } });
  } catch {
    return json({ error: "Couldn't reach FIRST's API." }, 502);
  }
  const text = await res.text();
  // pass FIRST's own status through, but never its error page (could echo request details)
  const ok = res.ok && text.trim().startsWith("{");
  const body = ok ? text : JSON.stringify({ error: res.status === 401 ? "FIRST didn't accept the API login. Check the secrets." : `FIRST's API answered ${res.status}.` });
  const status = ok ? 200 : res.status === 401 ? 502 : res.status === 404 ? 404 : 502;
  if (ok || status === 404) cache.set(path, { at: Date.now(), status, body });
  if (cache.size > 500) cache.clear();
  return new Response(body, { status, headers: { ...CORS, "Content-Type": "application/json" } });
});
