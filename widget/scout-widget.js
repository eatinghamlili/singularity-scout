// Singularity Scout widget for Scriptable (iPhone / iPad) · Team 51 NerdHerd Singularity
// Shows our next match (time, alliance, partner, opponents) during a competition, our next
// competition between events, and our rank and record. Tap it to open Singularity Scout.
// With your name it also shows YOUR quals: the robots a lead handed you, when they play, and
// any played ones you still need to write up.
//   Set your name: long-press the widget › Edit Widget › Parameter, type your name as it shows on
//   the board (or your username). Running the script once in Scriptable asks for it too.
// Reads public data only (FTCScout, and the board's hand-outs with the same public key the website
// uses): no scout code, no password, nothing is saved anywhere but this phone.
// Works on the home screen (small or medium) and the lock screen (rectangular or inline).

const TEAM = 51;
const SITE = "https://eatinghamlili.github.io/singularity-scout/";
const API = "https://api.ftcscout.org/rest/v1";
// the board's database (read-only, public key: the same one in the website's supabase-config.js)
const BOARD = { url: "https://facgwsflliuhndhrfwmh.supabase.co", key: "sb_publishable_x0zjIjHCvLrtNAZ9GeQY2g_CQoYfFIl" };
const NAME_KEY = "ss51-widget-scout";

const C = {
  bg1: new Color("#1b0f33"), bg2: new Color("#3b0764"),
  ink: new Color("#f5f3ff"), muted: new Color("#c4b5fd"), accent: new Color("#e879f9"),
  red: new Color("#fca5a5"), blue: new Color("#93c5fd"), good: new Color("#86efac"), late: new Color("#fcd34d"),
};

// ---------- data ----------
const season = (d = new Date()) => (d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1); // FTC seasons start in September
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function getJSON(path) {
  const r = new Request(API + path);
  r.timeoutInterval = 12;
  return await r.loadJSON();
}
async function board(query) {
  const r = new Request(`${BOARD.url}/rest/v1/docs?${query}`);
  r.headers = { apikey: BOARD.key, Authorization: "Bearer " + BOARD.key };
  r.timeoutInterval = 12;
  const rows = await r.loadJSON();
  if (!Array.isArray(rows)) throw new Error("board");
  return rows;
}

// who's scouting: the widget's parameter, or the name saved when the script was run in the app
function scoutName() {
  const p = String(args.widgetParameter || "").trim();
  if (p) return p;
  try { return Keychain.contains(NAME_KEY) ? Keychain.get(NAME_KEY) : ""; } catch (e) { return ""; }
}
const norm = (s) => String(s || "").trim().toLowerCase();

// the quals a lead handed this scout at today's competition, and which of them are written up
async function loadMine(name, live, s, today) {
  if (!name) return null;
  const scouts = await board("select=path,data&path=like.scouts/*");
  const me = scouts.find((r) => r.data && !r.data.pending && (norm(r.data.name) === norm(name) || (r.data.handle && norm(r.data.handle) === norm(name))));
  if (!me) return { name, unknown: true };
  const uid = "s_" + String(me.path).slice(7), shown = me.data.display === "username" && me.data.handle ? me.data.handle : me.data.name;
  // which competition: ours today, or whichever one the board has running today
  let code = live && live.code, yr = s, matches = live && live.matches;
  if (!code) {
    const evs = await board("select=path,data&path=like.events/*&path=not.like.events/*/*");
    const on = evs.filter((r) => r.data && r.data.start && String(r.data.start).slice(0, 10) <= today && today <= String(r.data.end || r.data.start).slice(0, 10))
      .sort((a, b) => (!!b.data.hasUs - !!a.data.hasUs) || (!!b.data.starred - !!a.data.starred));
    if (!on.length) return { name: shown, noEvent: true };
    const k = String(on[0].path).slice(7);
    yr = Number(k.slice(0, 4)); code = k.slice(5);
  }
  const prefix = `events/${yr}-${code}/teams/`;
  const handed = (await board(`select=path,assigned:data->assigned&path=like.${encodeURIComponent(prefix)}*`)).filter((r) => r.assigned && r.assigned[uid]);
  if (!handed.length) return { name: shown, season: yr, code, rows: [] };
  const notesOf = new Map((await board(`select=path,notes:data->notes&path=in.(${encodeURIComponent(handed.map((r) => `"${r.path}"`).join(","))})`)).map((r) => [r.path, r.notes || {}]));
  if (!matches) matches = (await getJSON(`/events/${yr}/${code}/matches`)) || [];
  const rows = [];
  for (const t of handed) {
    const num = Number(String(t.path).split("/").pop()), a = t.assigned[uid];
    const picked = Array.isArray(a.quals) && a.quals.length ? new Set(a.quals) : null;   // none listed = all of that team's quals
    const done = new Set(Object.values(notesOf.get(t.path) || {}).filter((n) => n && n.by === uid && n.ctx === "qual" && n.match).map((n) => n.match));
    for (const m of matches) {
      if (m.tournamentLevel !== "Quals") continue;
      const seat = (m.teams || []).find((x) => x.teamNumber === num); if (!seat) continue;
      const key = "Q-0-" + m.id; if (picked && !picked.has(key)) continue;
      rows.push({ id: m.id, team: num, color: seat.alliance, time: m.scheduledStartTime || null, played: !!m.hasBeenPlayed, done: done.has(key) });
    }
  }
  rows.sort((x, y) => x.id - y.id);
  return { name: shown, season: yr, code, rows, next: rows.filter((r) => !r.played && !r.done).slice(0, 4),
    late: rows.filter((r) => r.played && !r.done).length, doneN: rows.filter((r) => r.done).length };
}

// what to show: "live" (we're competing today), "next" (an upcoming competition) or "past"
async function loadState(now = new Date()) {
  const s = season(now);
  const mine = (await getJSON(`/teams/${TEAM}/events/${s}`)) || [];
  const events = await Promise.all(mine.map(async (x) => {
    const e = await getJSON(`/events/${s}/${x.eventCode}`);
    return { code: x.eventCode, name: e.name, start: e.start, end: e.end, city: e.city, stats: x.stats };
  }));
  const today = dayKey(now);
  const name = scoutName();
  const scout = async (live) => { try { return await loadMine(name, live, s, today); } catch (e) { return name ? { name, error: true } : null; } };
  const live = events.find((e) => e.start && e.end && String(e.start).slice(0, 10) <= today && today <= String(e.end).slice(0, 10));
  if (live) {
    const ms = (await getJSON(`/events/${s}/${live.code}/matches`)) || [];
    const ours = ms
      .filter((m) => (m.teams || []).some((t) => t.teamNumber === TEAM))
      .sort((a, b) => String(a.scheduledStartTime || "").localeCompare(String(b.scheduledStartTime || "")) || a.id - b.id);
    const next = ours.find((m) => !m.hasBeenPlayed);
    let match = null;
    if (next) {
      const side = (c) => (next.teams || []).filter((t) => t.alliance === c).map((t) => t.teamNumber);
      const red = side("Red"), blue = side("Blue"), weRed = red.includes(TEAM);
      const lvl = next.tournamentLevel === "Quals" ? "Q" : next.tournamentLevel === "Playoff" || next.tournamentLevel === "DoubleElim" ? "P" : "";
      match = {
        label: lvl + (next.series ? next.series + "-" : "") + next.id,
        time: next.scheduledStartTime || null,
        color: weRed ? "Red" : "Blue",
        partners: (weRed ? red : blue).filter((n) => n !== TEAM),
        opponents: weRed ? blue : red,
        left: ours.filter((m) => !m.hasBeenPlayed).length,
      };
    }
    return { kind: "live", season: s, event: live, match, played: ours.filter((m) => m.hasBeenPlayed).length, mine: await scout({ code: live.code, matches: ms }), at: Date.now() };
  }
  const upcoming = events.filter((e) => e.start && String(e.start).slice(0, 10) > today).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  if (upcoming.length) return { kind: "next", season: s, event: upcoming[0], mine: await scout(null), at: Date.now() };
  const past = events.filter((e) => e.end).sort((a, b) => String(b.end).localeCompare(String(a.end)));
  return { kind: "past", season: s, event: past[0] || null, mine: await scout(null), at: Date.now() };
}

// keep the last good answer so a weak signal at the venue still shows something
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "singularity-scout-widget.json");
async function stateWithCache() {
  try { const st = await loadState(); fm.writeString(cachePath, JSON.stringify(st)); return st; }
  catch (e) {
    if (fm.fileExists(cachePath)) { const st = JSON.parse(fm.readString(cachePath)); st.stale = true; return st; }
    return { kind: "error", message: "Can't reach FTCScout" };
  }
}

// ---------- helpers for the words ----------
const fmtTime = (iso) => { if (!iso) return ""; const df = new DateFormatter(); df.dateFormat = "h:mm a"; return df.string(new Date(iso)); };
const fmtDay = (iso) => { const df = new DateFormatter(); df.dateFormat = "EEE, MMM d"; return df.string(new Date(String(iso).slice(0, 10) + "T12:00:00")); };
const daysUntil = (iso) => { const a = new Date(); a.setHours(0, 0, 0, 0); const b = new Date(String(iso).slice(0, 10) + "T00:00:00"); return Math.round((b - a) / 86400000); };
const record = (st) => (st && st.wins != null ? `${st.wins}-${st.losses}-${st.ties}` : "");
const rankLine = (ev) => { const st = ev && ev.stats; if (!st || !st.qualMatchesPlayed) return ""; return `Rank #${st.rank} · ${record(st)}`; };
const short = (name) => String(name || "").replace(/^SoCal\s*-\s*/i, "");
const colorOf = (c) => (c === "Red" ? C.red : c === "Blue" ? C.blue : C.ink);
const lateTxt = (n) => `${n} to write up !`;

function headline(state) {
  if (state.kind === "error") return { top: "Team 51", big: "No signal", sub: state.message };
  const ev = state.event;
  if (state.kind === "live") {
    if (state.match) {
      const m = state.match;
      return {
        top: short(ev.name), big: `${m.label}${m.time ? " · " + fmtTime(m.time) : ""}`, color: m.color,
        sub: `${m.color}${m.partners.length ? " with " + m.partners.join(" & ") : ""}`,
        vs: `vs ${m.opponents.join(" & ")}`, foot: rankLine(ev),
      };
    }
    return { top: short(ev.name), big: state.played ? "All matches played" : "Schedule not out yet", sub: rankLine(ev) || "Good luck, Team 51!", foot: "" };
  }
  if (state.kind === "next" && ev) {
    const d = daysUntil(ev.start);
    return { top: "Next competition", big: short(ev.name), sub: `${fmtDay(ev.start)} · ${d === 1 ? "tomorrow" : `in ${d} days`}`, foot: ev.city || "" };
  }
  if (ev) return { top: "Last competition", big: short(ev.name), sub: rankLine(ev) || fmtDay(ev.end), foot: "" };
  return { top: "Team 51", big: "No competitions yet", sub: "this season", foot: "" };
}

// the scout's own part: null when there's nothing to say (no name set, or no competition today)
function myQuals(state) {
  const m = state.mine;
  if (!m) return null;
  if (m.unknown) return { title: "Your quals", lines: [{ t: `"${m.name}" isn't on the roster`, c: C.muted }, { t: "Check the widget's name", c: C.muted }] };
  if (m.error) return { title: "Your quals", lines: [{ t: "Couldn't check the board", c: C.muted }] };
  if (m.noEvent || !m.rows) return null;
  if (!m.rows.length) return { title: "Your quals", lines: [{ t: "None handed out yet", c: C.muted }] };
  const lines = [];
  if (m.late) lines.push({ t: lateTxt(m.late), c: C.late, bold: true });
  for (const r of m.next) lines.push({ t: `Q${r.id}${r.time ? " " + fmtTime(r.time) : ""} · ${r.team}`, c: colorOf(r.color), bold: lines.length === (m.late ? 1 : 0) });
  if (!m.next.length && !m.late) lines.push({ t: "All written up ✓", c: C.good, bold: true });
  return { title: "Your quals", lines, first: m.next[0] || null, late: m.late };
}

// ---------- drawing ----------
async function icon() {
  const p = fm.joinPath(fm.documentsDirectory(), "singularity-scout-icon.png");
  if (fm.fileExists(p)) return fm.readImage(p);
  try { const img = await new Request(SITE + "icon-192.png").loadImage(); fm.writeImage(p, img); return img; } catch { return null; }
}

function text(stack, str, size, color, bold, lines = 1) {
  const t = stack.addText(str);
  t.font = bold ? Font.heavySystemFont(size) : Font.mediumSystemFont(size);
  t.textColor = color; t.lineLimit = lines; t.minimumScaleFactor = 0.6;
  return t;
}

async function build(state) {
  const w = new ListWidget();
  const family = config.widgetFamily || "medium";
  const h = headline(state);
  const mq = myQuals(state);
  const nextMine = mq && mq.first;
  const ev = state.event;
  w.url = state.mine && state.mine.code ? `${SITE}#${state.mine.season}-${state.mine.code}` : ev && state.season ? `${SITE}#${state.season}-${ev.code}` : SITE;
  // refresh often on match days (ours or the scout's), slowly otherwise
  const busy = state.kind === "live" || (state.mine && state.mine.rows && state.mine.rows.length);
  w.refreshAfterDate = new Date(Date.now() + (busy ? 5 : 60) * 60000);

  // a scout with quals today: the small and lock-screen widgets show their next one instead of ours
  const scoutFirst = !!(mq && (nextMine || mq.late));
  const mineTop = nextMine ? `Q${nextMine.id}${nextMine.time ? " · " + fmtTime(nextMine.time) : ""}` : lateTxt(mq ? mq.late : 0);
  const mineSub = nextMine ? `Watch ${nextMine.team} (${nextMine.color})` : "Open the board to write them up";
  const mineFoot = nextMine && mq.late ? lateTxt(mq.late) : "";

  if (family === "accessoryInline") {
    if (scoutFirst) w.addText(nextMine ? `${mineTop} · watch ${nextMine.team}` : mineTop);
    else w.addText(state.kind === "live" && state.match ? `${h.big} · ${state.match.color}` : `${h.big}`);
    return w;
  }
  if (family === "accessoryRectangular" || family === "accessoryCircular") {
    // the lock screen tints everything itself: plain text, no colors
    w.addAccessoryWidgetBackground = true;
    if (scoutFirst) {
      text(w, "Your next qual", 11, Color.white(), false);
      text(w, mineTop, 15, Color.white(), true);
      text(w, [mineSub, mineFoot].filter(Boolean).join(" · "), 11, Color.white(), false, 2);
    } else {
      text(w, h.top, 11, Color.white(), false);
      text(w, h.big, 15, Color.white(), true);
      text(w, [h.sub, h.vs].filter(Boolean).join(" "), 11, Color.white(), false, 2);
    }
    return w;
  }

  const g = new LinearGradient(); g.colors = [C.bg1, C.bg2]; g.locations = [0, 1]; w.backgroundGradient = g;
  w.setPadding(12, 14, 12, 14);
  const small = family === "small";

  const top = w.addStack(); top.centerAlignContent();
  const img = await icon();
  if (img) { const i = top.addImage(img); i.imageSize = new Size(small ? 20 : 24, small ? 20 : 24); i.cornerRadius = 6; top.addSpacer(6); }
  text(top, small ? "Scout 51" : "Singularity Scout", small ? 11 : 12, C.muted, true);
  top.addSpacer();
  if (state.stale) text(top, "offline", 10, C.muted, false);
  w.addSpacer(small ? 6 : 8);

  if (small && scoutFirst) {
    text(w, "YOUR NEXT QUAL", 10, C.accent, true);
    w.addSpacer(2);
    text(w, mineTop, nextMine ? 20 : 15, nextMine ? C.ink : C.late, true, 2);
    w.addSpacer(4);
    text(w, mineSub, 12, nextMine ? colorOf(nextMine.color) : C.muted, true, 2);
    if (mineFoot) text(w, mineFoot, 11, C.late, true);
    w.addSpacer();
    return w;
  }

  // medium (and small without quals): our match on the left, the scout's quals on the right
  const body = w.addStack(); body.layoutHorizontally(); body.topAlignContent();
  const left = body.addStack(); left.layoutVertically();
  text(left, h.top.toUpperCase(), 10, C.accent, true);
  left.addSpacer(2);
  text(left, h.big, small ? 20 : mq ? 20 : 24, C.ink, true, small ? 2 : 1);
  left.addSpacer(4);
  const col = h.color === "Red" ? C.red : h.color === "Blue" ? C.blue : C.ink;
  if (h.sub) text(left, h.sub, small ? 12 : 13, col, true, 2);
  if (h.vs) text(left, h.vs, small ? 12 : 13, C.ink, false, 2);
  if (mq && !small) {
    body.addSpacer(10);
    const right = body.addStack(); right.layoutVertically(); right.size = new Size(122, 0);
    text(right, mq.title.toUpperCase(), 10, C.accent, true);
    right.addSpacer(3);
    for (const l of mq.lines.slice(0, 4)) { text(right, l.t, 12, l.c, !!l.bold); right.addSpacer(1); }
  } else body.addSpacer();
  w.addSpacer();
  if (h.foot && !small) text(w, h.foot, 11, C.muted, false);
  if (state.at && !small) {
    const df = new DateFormatter(); df.dateFormat = "h:mm a";
    text(w, `Updated ${df.string(new Date(state.at))}${state.mine && state.mine.name && !state.mine.unknown ? " · " + state.mine.name : ""}`, 9, C.muted, false);
  }
  return w;
}

// run inside the Scriptable app (not as a widget): ask for the scout's name once, then show a preview
if (!config.runsInWidget && !String(args.widgetParameter || "").trim()) {
  try {
    const a = new Alert();
    a.title = "Your name on the board";
    a.message = "Type it as it shows on Singularity Scout (or your username) to see the quals you've been handed. Leave it empty for Team 51's matches only.";
    a.addTextField("e.g. Annabelle", scoutName());
    a.addAction("Save"); a.addCancelAction("Skip");
    if ((await a.present()) === 0) {
      const v = a.textFieldValue(0).trim();
      if (v) Keychain.set(NAME_KEY, v); else if (Keychain.contains(NAME_KEY)) Keychain.remove(NAME_KEY);
    }
  } catch (e) { /* no alerts here: just show the preview */ }
}

const state = await stateWithCache();
const widget = await build(state);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();   // tapping ▶ in Scriptable shows a preview
Script.complete();
