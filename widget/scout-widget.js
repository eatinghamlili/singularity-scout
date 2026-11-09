// Singularity Scout widget for Scriptable (iPhone / iPad) · Team 51 NerdHerd Singularity
// Shows our next match (time, alliance, partner, opponents) during a competition, our next
// competition between events, and our rank and record. Tap it to open Singularity Scout.
// Reads FTCScout's public data only: no scout code, nothing is saved anywhere but this phone.
// Works on the home screen (small or medium) and the lock screen (rectangular or inline).

const TEAM = 51;
const SITE = "https://eatinghamlili.github.io/singularity-scout/";
const API = "https://api.ftcscout.org/rest/v1";

const C = {
  bg1: new Color("#1b0f33"), bg2: new Color("#3b0764"),
  ink: new Color("#f5f3ff"), muted: new Color("#c4b5fd"), accent: new Color("#e879f9"),
  red: new Color("#fca5a5"), blue: new Color("#93c5fd"), good: new Color("#86efac"),
};

// ---------- data ----------
const season = (d = new Date()) => (d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1); // FTC seasons start in September
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function getJSON(path) {
  const r = new Request(API + path);
  r.timeoutInterval = 12;
  return await r.loadJSON();
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
    return { kind: "live", season: s, event: live, match, played: ours.filter((m) => m.hasBeenPlayed).length, at: Date.now() };
  }
  const upcoming = events.filter((e) => e.start && String(e.start).slice(0, 10) > today).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  if (upcoming.length) return { kind: "next", season: s, event: upcoming[0], at: Date.now() };
  const past = events.filter((e) => e.end).sort((a, b) => String(b.end).localeCompare(String(a.end)));
  return { kind: "past", season: s, event: past[0] || null, at: Date.now() };
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
  const ev = state.event;
  w.url = ev && state.season ? `${SITE}#${state.season}-${ev.code}` : SITE;
  // refresh often on match days, slowly otherwise
  w.refreshAfterDate = new Date(Date.now() + (state.kind === "live" ? 5 : 60) * 60000);

  if (family === "accessoryInline") {
    w.addText(state.kind === "live" && state.match ? `${h.big} · ${state.match.color}` : `${h.big}`);
    return w;
  }
  if (family === "accessoryRectangular" || family === "accessoryCircular") {
    // the lock screen tints everything itself: plain text, no colors
    w.addAccessoryWidgetBackground = true;
    text(w, h.top, 11, Color.white(), false);
    text(w, h.big, 15, Color.white(), true);
    text(w, [h.sub, h.vs].filter(Boolean).join(" "), 11, Color.white(), false, 2);
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
  text(w, h.top.toUpperCase(), 10, C.accent, true);
  w.addSpacer(2);
  text(w, h.big, small ? 20 : 24, C.ink, true, small ? 2 : 1);
  w.addSpacer(4);
  const col = h.color === "Red" ? C.red : h.color === "Blue" ? C.blue : C.ink;
  if (h.sub) text(w, h.sub, small ? 12 : 14, col, true, 2);
  if (h.vs) text(w, h.vs, small ? 12 : 14, C.ink, false, 2);
  w.addSpacer();
  if (h.foot && !small) text(w, h.foot, 11, C.muted, false);
  if (state.at && !small) {
    const df = new DateFormatter(); df.dateFormat = "h:mm a";
    text(w, `Updated ${df.string(new Date(state.at))}`, 9, C.muted, false);
  }
  return w;
}

const state = await stateWithCache();
const widget = await build(state);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();   // tapping ▶ in Scriptable shows a preview
Script.complete();
