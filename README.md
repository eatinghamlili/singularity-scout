# Singularity Scout

Team 51 (NerdHerd Singularity) scouting and alliance-selection board, as a normal website.

- **Rankings stay current on their own.** Every scout's browser pulls standings from FTCScout every few minutes while a competition is on. Nobody's laptop has to stay open.
- **Anyone with the link can use it.** No Claude account. Scouts sign in with their 4-digit code.
- **Shared live.** Notes, numbers, picks and the roster update on everyone's screen within a second or two (Supabase Realtime).

Hosting is free: GitHub Pages serves the page, Supabase stores the shared data.

**Live site:** <https://eatinghamlili.github.io/singularity-scout/>

## Already done

- **Supabase project `singularity-scout`** (organization "FTC SCOUT", free plan, US West) is created and set up: the `docs` table, security rules, the note-merging function and live updates. The SQL is in `supabase/schema.sql`.
- **`supabase-config.js`** already has the project's address and publishable key. These are meant to be public; the database's security rules decide what visitors can do.
- **The claude.ai board's data is imported:** 12 competitions, 171 teams, every note, rating and pick, the roster (ethan, bob, rohan meowl) and settings. **Everyone's existing 4-digit codes work.**

## Putting it online again from scratch (only if the repository is ever lost)

1. Sign in to GitHub (create an account if the team doesn't have one) and click **New repository**. Name it `singularity-scout`, set it to **Public**, and create it.
2. Click **uploading an existing file**, drag in **everything in this folder** (`index.html`, `platform.js`, `supabase-config.js`, `README.md`, and the `supabase` and `tools` folders), and press **Commit changes**.
3. Go to the repository's **Settings → Pages**. Under **Build and deployment**, pick **Deploy from a branch**, choose branch `main` and folder `/ (root)`, and press **Save**.
4. After a minute the site is live at `https://<github-username>.github.io/singularity-scout/`. Open it and sign in with your code.
5. Send the link to the team. Leads add scouts in **Team roster** and give each one a code.

## AI overview of a team's notes (switched off for now)

When someone opens a team, the board asks Claude for a short overview of every scout's notes and numbers (strengths, concerns, disagreements, a pick take) and saves it so everyone sees the same one. It's written again only when that team gets new notes or numbers.

It runs in the Supabase function `team-recap` (`supabase/functions/team-recap/index.ts`), which builds the prompt from the database, so visitors can't use the key for anything else.

**It's switched off for now.** To switch it on: in `platform.js` set `const AI_OVERVIEW = true`, upload it, then:
1. Get an Anthropic API key at <https://console.anthropic.com> (a mentor or lead with billing set up). Usage is paid; each overview costs roughly a cent.
2. In the Supabase dashboard, open **singularity-scout → Edge Functions → Secrets** (or Project Settings → Edge Functions), add a secret named `ANTHROPIC_API_KEY`, paste the key, and save.
3. Open any team with notes. The overview appears within a few seconds.

Never put the key in the website files; they're public.

## Official data from FIRST

Rankings, match results and registrations come from FIRST's official FTC Events API, through the Supabase function `ftc-events` (`supabase/functions/ftc-events/index.ts`). The API key stays in Supabase's secrets; the website never sees it, and the function only lets four public lists through (an event, its teams, rankings and the match schedule/results).

- The key is the Supabase secret `first_key`. The FIRST username defaults to the account the key was issued to; a secret named `FTC_API_USERNAME` holding a username overrides it.
- OPR still comes from FTCScout (FIRST doesn't publish it).
- If FIRST can't be reached, the site switches to FTCScout on its own. The Quals tab says which one it's showing.

## How it behaves

- **Leads** load competitions from FTCScout and manage the roster. **Scouts** rate, write notes, mark picks and request competitions.
- **Live updates** start by themselves when a scout opens a competition that's happening (from the day before to the day after). Any scout can also press **Refresh now**. Late registrations are added automatically.
- **Notes from different scouts never overwrite each other**, even when they save at the same moment. The database merges them.
- **AI recap** isn't available on the website. It relied on Claude inside claude.ai.

## Security, honestly

- **Anyone with the link can read the board and add scouting.** 4-digit codes tell teammates apart; they are not passwords.
- The database refuses: deleting competitions or teams, records outside the board's own types, unexpected fields, and very large records. Only roster entries and competition requests can be removed.
- Your team's notes are visible to anyone who has the link, so share it only with the team.

## Keeping it running

- **Free Supabase projects pause after about a week with no activity.** If the site says it can't reach the database after a quiet stretch, a lead signs in at <https://supabase.com/dashboard>, opens **singularity-scout**, and presses **Restore project**. The data is kept.
- Free limits (500 MB database, generous API use) are far above what one team's scouting needs.
- **FIRST's API key** (when it arrives) must not go in this public site. FTCScout needs no key, so the site doesn't need one.

## Updating the page later

The page's source is `src/board.html` (the same file also runs as the claude.ai board). After changing it:

```
python tools/build-site.py src/board.html
```

Then commit and push; GitHub Pages serves the new `index.html` within a minute.

A daily automated maintenance run (Claude, scheduled on the team lead's computer) tests the site against the separate **dev** database, fixes problems, makes small improvements, and pushes only when every check passes. What it did each day is written to `docs/daily-log.md`.
