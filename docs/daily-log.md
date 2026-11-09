# Daily maintenance log

Each automated run adds an entry here: what it tested, what it fixed or improved, and whether it went live.

## 2026-11-08 (manual session)
- Live: server-checked sign-in (board function, private scout_keys, database locked to the function), photos (storage bucket "photos", Hexagon | Photo switch, tap the photo to change it), offline mode (sw.js + outbox), FIRST API (ftc-events).
- Fixed: roster now shows the server's reason (e.g. duplicate code) and drops a refused scout; offline changes upload as the scout who made them; site always fetches the newest files when online; a GitHub 503 for platform.js no longer leaves the page "Not connected" (offline helper serves its saved copy, failed scripts reload once); HEIC photos get a clear message.
- Full dev test pass: sign-in, home, stars, roster, pick list, rankings, notes cards, team view, notes with photos + Undo, match notes + Undo, predictor, offline, loading a competition, phone width, dark mode. Dev restored after.
