"""Builds the website's index.html from the scouting board page (alliance-pick-board.html).

The board was first made as a claude.ai page. This script turns it into a normal website:
  * the page loads Supabase + platform.js instead of relying on claude.ai features
  * FTCScout is fetched straight from the visitor's browser (no desktop app needed)
  * every signed-in scout's browser keeps rankings updated during a competition
  * leads (from the roster) do what the board owner did on claude.ai
  * claude.ai-only wording is replaced; AI overviews come from the team-recap server function

Run from the singularity-scout folder:   python tools/build-site.py ../alliance-pick-board.html
"""
import pathlib, sys

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "../alliance-pick-board.html")
out = pathlib.Path(__file__).resolve().parent.parent / "index.html"
page = src.read_text(encoding="utf-8").replace("\r\n", "\n")

REPLACE = [
    # fetch FTCScout directly; the browser allows it on a normal website
    ('get(path) { return browserJSON(this.api + path); },',
     'async get(path) { let r; try { r = await fetch(this.api + path); } catch (e) { throw { code: "x", message: "Couldn\'t reach " + this.name + ". Check the internet connection." }; } const txt = await r.text(); try { return JSON.parse(txt); } catch { throw { code: "not_json", message: txt.slice(0, 160) }; } },'),
    # leads take the board owner's role
    ('  function render() {\n',
     '  function render() {\n    isOwner = !!meScout()?.lead;   // website: leads load competitions and manage the board\n'),
    # live updates run in every signed-in scout's browser
    ('    if (liveBusy || !current || !isOwner || !db || readOnly) return;',
     '    if (liveBusy || !current || !uid || !db || readOnly) return;'),
    ('    if (!current || !isOwner) return;\n    liveOn = true;',
     '    if (!current || !uid) return;\n    liveOn = true;'),
    ('if (!silent && db && key && events.get(key)?.live?.on)',
     'if (!silent && false && db && key && events.get(key)?.live?.on)'),
    ('    const live = ev.live || null;\n',
     '    // website: start keeping standings current as soon as a scout opens a competition that is on now\n'
     '    const today = new Date().toISOString().slice(0, 10), dayMs = 864e5;\n'
     '    const shift = (d, n) => new Date(Date.parse(d + "T12:00:00") + n * dayMs).toISOString().slice(0, 10);\n'
     '    if (!liveOn && uid && !readOnly && liveAutoFor !== current && ev.start && today >= shift(ev.start, -1) && today <= shift(ev.end || ev.start, 1)) { liveAutoFor = current; setTimeout(startLive, 0); }\n'
     '    const live = ev.live || null;\n'),
    ('  let liveOn = false, liveEvery = 3,',
     '  let liveAutoFor = null;\n  let liveOn = false, liveEvery = 3,'),
    ('They resume when the board owner\'s Claude desktop app has this competition open.',
     'They resume as soon as any scout has this competition open.'),
    ('${isOwner ? "" : " Live updates aren\'t running."}', ' Open during the event to keep them current.'),
    ('const ownerCtl = isOwner && !readOnly ?', 'const ownerCtl = uid && !readOnly ?'),
    ('Turn on live updates (board owner, desktop app) to keep them current.',
     'They update automatically while any scout has this competition open.'),
    # wording that only made sense on claude.ai
    ('Pulls teams, rankings and OPR from ${SOURCE.name} through the Claude desktop app\'s browser. Everyone on the board sees the result.',
     'Pulls teams, rankings and OPR from ${SOURCE.name}. Everyone on the board sees the result.'),
    ('Loading from ${SOURCE.name} runs on the board owner\'s Claude desktop app. Request a competition here and it appears for everyone once it\'s loaded.',
     'Team leads load competitions. Request one here and it appears for everyone once a lead loads it.'),
    ('"Waiting for the board owner to load it in the Claude desktop app."', '"Waiting for a lead to load it."'),
    ('"You need Contributor access to request competitions."', '"This device can\'t save right now, so the request wasn\'t sent."'),
    ('Saving is off in this view, so a loaded competition would be lost. Open the board on claude.ai.',
     'The team database isn\'t connected, so a loaded competition would be lost.'),
    ('and share this board with them as <b>Contributor</b> from the Share menu. Contributors can rate teams, leave notes, mark picks and request competitions.',
     'and send them this website\'s link. Scouts can rate teams, leave notes, mark picks and request competitions; leads can also load competitions.'),
    ('`<b>Saving is off here.</b> Open this board on claude.ai so loaded competitions and ratings are shared with your team.`',
     '`<b>Not connected.</b> ${esc(window.SITE?.problem || "Couldn\'t reach the team database.")}`'),
    ('`<b>View only.</b> Ask the board\'s owner for Contributor access to rate teams and mark picks.`',
     '`<b>Can\'t save.</b> The team database refused a change. Ask a lead to check the database setup (README.md).`'),
    ('Everyone with Contributor access can rate.', 'Every scout with a code can rate.'),
    ('"Open this board on claude.ai to load and save competitions."', '"The team database isn\'t connected yet. See README.md."'),
    ('"Notes save only when the board is open on claude.ai."', '"The team database isn\'t connected, so notes can\'t be saved."'),
    ('"View-only access can\'t add notes."', '"This device can\'t save notes right now."'),
    # the website gets AI overviews from its own server function (supabase/functions/team-recap), not claude.ai.
    # Switched off for now: the section is hidden unless platform.js turns window.SITE.recap on.
    ('  getSample();\n', '  if (!window.SITE) getSample();\n'),
    ('  function recapBox(t) {\n', '  function recapBox(t) {\n    if (window.SITE && !window.SITE.recap) return "";   // AI overview switched off on the website\n'),
]

for old, new in REPLACE:
    n = page.count(old)
    if n != 1:
        sys.exit(f"build-site: expected 1 match, found {n}:\n  {old[:90]}")
    page = page.replace(old, new)

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Team 51 NerdHerd Singularity's FTC scouting and alliance selection board.">
<meta name="theme-color" content="#1b0f33">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js"></script>
<script src="supabase-config.js"></script>
<script src="platform.js"></script>
</head>
<body>
"""
out.write_text(HEAD + page + "\n</body>\n</html>\n", encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
