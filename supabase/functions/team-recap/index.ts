// AI overview of everyone's scouting on one team, written by Claude and saved on the team.
//
// The browser only says WHICH team (event + number). The prompt is built here from the
// database, so visitors can't use the team's Anthropic key for anything else. A recap is only
// re-written when the team's notes or numbers changed since the last one, so opening a team
// again costs nothing.
//
// Needs the secret ANTHROPIC_API_KEY (Supabase dashboard -> Edge Functions -> Secrets).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Rating = Record<string, unknown> & { scale?: number; at?: number; note?: string };
type Note = { by?: string; text?: string; at?: number; changed?: boolean } | null;
type Team = {
  number?: number; name?: string; tags?: string[]; dnp?: boolean;
  mobility?: { ok?: boolean } | null;
  ev?: Record<string, number | null> | null; season?: Record<string, number | null> | null;
  ratings?: Record<string, Rating | null>; notes?: Record<string, Note>;
  aiRecap?: { text: string; at: number; inputs: string } | null;
};

const CATS: [string, string][] = [["auto", "Auto"], ["teleop", "TeleOp scoring"], ["endgame", "Endgame"],
  ["driving", "Driving"], ["reliability", "Reliability"], ["defense", "Defense"]];
// ratings saved before the 1-10 switch have no scale and were out of 5
const score = (r: Rating, k: string) => { const x = Number(r?.[k]); return x >= 1 ? (r.scale === 10 ? x : x * 2) : null; };
const fmt = (v: unknown) => (Math.round(Number(v || 0) * 10) / 10).toFixed(1);

function collectNotes(t: Team) {
  const out: { by: string; text: string; at: number; changed: boolean }[] = [];
  for (const x of Object.values(t.notes || {})) if (x && x.text) out.push({ by: x.by || "", text: x.text, at: x.at || 0, changed: !!x.changed });
  for (const [id, r] of Object.entries(t.ratings || {})) if (r && r.note) out.push({ by: id, text: String(r.note), at: Number(r.at) || 0, changed: false });
  return out.sort((a, b) => a.at - b.at);
}
function raters(t: Team) {
  return Object.entries(t.ratings || {}).filter(([, r]) => r && CATS.some(([k]) => score(r, k) != null)) as [string, Rating][];
}
// what the recap is based on; when this changes, the recap is stale
function signature(t: Team) {
  const notes = collectNotes(t).map((n) => `${n.by}:${n.at}`).join(",");
  const nums = raters(t).map(([id, r]) => `${id}:${CATS.map(([k]) => score(r, k) ?? "").join("/")}`).join(",");
  return `${notes}|${nums}|${t.dnp ? 1 : 0}|${t.mobility?.ok ?? ""}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  let body: { event?: string; team?: number; force?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const event = String(body.event || ""), team = Number(body.team);
  if (!/^[0-9]{4}-[A-Z0-9]{1,30}$/.test(event) || !Number.isInteger(team) || team < 1 || team > 999999) return json({ error: "bad_request" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const path = `events/${event}/teams/${team}`;
  const [{ data: row }, { data: evRow }, { data: scoutRows }] = await Promise.all([
    db.from("docs").select("data").eq("path", path).maybeSingle(),
    db.from("docs").select("data").eq("path", `events/${event}`).maybeSingle(),
    db.from("docs").select("path,data").eq("parent", "scouts"),
  ]);
  if (!row) return json({ error: "not_found" }, 404);
  const t = row.data as Team;
  const notes = collectNotes(t), rated = raters(t);
  if (!notes.length && !rated.length) return json({ error: "nothing_to_recap" }, 400);

  const inputs = signature(t);
  // unchanged since the last recap: hand back the saved one (also stops repeat clicks from spending)
  if (t.aiRecap && t.aiRecap.inputs === inputs && (!body.force || Date.now() - t.aiRecap.at < 5 * 60_000)) {
    return json({ ...t.aiRecap, cached: true });
  }
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "not_configured" }, 503);

  const names: Record<string, string> = {};
  for (const s of scoutRows || []) names["s_" + String(s.path).split("/")[1]] = String((s.data as { name?: string }).name || "a scout");
  const who = (id: string) => names[id] || "a former scout";
  const ev = (evRow?.data || {}) as { name?: string };
  const st = t.ev && Number(t.ev.played) >= 3 ? t.ev : (t.season || t.ev || {}) as Record<string, number | null>;

  const prompt = `You help FTC robotics Team 51 (NerdHerd Singularity) choose alliance partners. Write a short overview of what Team 51's scouts think of team ${team}${t.name ? ` (${t.name})` : ""}${ev.name ? ` at ${ev.name}` : ""}.
Use only the information below. Do not invent facts. Later notes describe more recent matches, so weigh them more when scouts saw a change. If scouts disagree, say so. Scout ratings are out of 10.

Write plain text in exactly this shape, under 130 words:
Overall: one sentence.
Strengths:
- up to 3 short bullets
Concerns:
- up to 3 short bullets (write "- None noted" if there are none)
Scouts disagree on: one line, or "Nothing major".
Pick take for Team 51: one sentence.

DATA
Stats (OPR points per match): auto ${fmt(st.auto)}, teleop ${fmt(st.teleop)}, endgame ${fmt(st.endgame)}, penalties given ${fmt(t.ev?.pen ?? 0)}${t.ev?.rank ? `, qualification rank ${t.ev.rank} (${t.ev.w}-${t.ev.l}-${t.ev.t})` : ""}.
Tags: ${(t.tags || []).join(", ") || "none"}.${t.dnp ? " Marked DO NOT PICK by the team." : ""}${t.mobility ? (t.mobility.ok ? " Scouts confirmed the robot can move." : " A scout marked that the robot CAN'T MOVE.") : ""}
Scout numbers (each scout's latest):
${rated.length ? rated.map(([id, r]) => `- ${who(id)}: ` + CATS.map(([k, l]) => score(r, k) != null ? `${l} ${score(r, k)}` : "").filter(Boolean).join(", ")).join("\n") : "- none"}
Notes, oldest first:
${notes.length ? notes.map((n, i) => `- [${i + 1}] ${who(n.by)}${n.changed ? " (updated their numbers)" : ""}: ${n.text}`).join("\n") : "- none"}`;

  const client = new Anthropic();
  let text = "";
  try {
    // deno-lint-ignore no-explicit-any
    const res: any = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    // deno-lint-ignore no-explicit-any
    } as any);
    if (res.stop_reason === "refusal") return json({ error: "refused" }, 422);
    // deno-lint-ignore no-explicit-any
    text = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "not_configured" }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: "ai_error", status: e.status }, 502);
    return json({ error: "ai_error" }, 502);
  }
  if (!text) return json({ error: "empty" }, 502);

  const recap = { text: text.slice(0, 4000), at: Date.now(), inputs, by: "ai" };
  const { error } = await db.rpc("merge_doc", { p_path: path, p_patch: { aiRecap: recap } });
  if (error) return json({ error: "save_failed" }, 500);
  return json({ ...recap, cached: false });
});
