// Connects the scouting page to Supabase when it runs as a normal website.
// The page was written against a small `claude.use(name)` interface (from its claude.ai
// version); this file provides the same interface backed by the Supabase `docs` table,
// so the page code stays the same.
//
//   db    -> Supabase: one row per board record (path + JSON), live via Supabase Realtime
//   user  -> a random id for this device (scouts are told apart by their 4-digit codes)
//   mcp   -> present, so the page fetches FTCScout directly from the browser
//   sample-> not available on the website (no AI recap)
(function () {
  const cfg = window.SUPABASE_CONFIG || {};
  const configured = !!(cfg.url && cfg.key && !/PASTE|YOUR_/i.test(cfg.url + cfg.key));
  window.SITE = { configured, problem: "" };

  let db = null;
  if (!configured) {
    window.SITE.problem = "This website isn't connected to its database yet. Add the Supabase settings to supabase-config.js (see README.md).";
  } else if (!window.supabase || !window.supabase.createClient) {
    window.SITE.problem = "Couldn't load Supabase. Check the internet connection and reload.";
  } else {
    const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
    const parentOf = (p) => p.replace(/\/[^/]+$/, "");
    const meta = { fromCache: false, hasPendingWrites: false };
    const mapErr = (e) => {
      const c = String((e && (e.code || e.status)) || "");
      if (c === "42501" || c === "401" || c === "403" || c === "PGRST301") return { code: "invalid_argument", message: e.message };
      if (c === "23514" || c === "22P02") return { code: "invalid_argument", message: e.message };
      return { code: "unavailable", message: (e && e.message) || "Database error" };
    };
    const snapOf = (path, row) => ({ id: path.split("/").pop(), exists: !!row, data: () => (row ? row.data : undefined), metadata: meta });
    // a request that never reached the database (no signal, venue Wi-Fi) rather than one it refused
    const isNetErr = (e) => !navigator.onLine || !!(e && (e.code === "offline" || (!e.code && /fetch|network|load failed|timed? ?out|abort/i.test(String(e.message || e)))));
    async function check(promise) {
      let res; try { res = await promise; } catch (e) { throw isNetErr(e) ? { code: "offline", message: String(e && e.message || e) } : mapErr(e); }
      const { data, error } = res;
      if (error) throw isNetErr(error) ? { code: "offline", message: error.message } : mapErr(error);
      return data;
    }

    /* ---- offline: everything read is kept on this phone, and changes made without signal wait in an
       outbox and upload in order once the connection is back. The database merges notes, so a scout
       uploading late never overwrites anyone else. ---- */
    const CK = "ss51-c:", OUTBOX = "ss51-outbox";
    const store = {
      get(k) { try { const v = localStorage.getItem(CK + k); return v ? JSON.parse(v) : undefined; } catch (e) { return undefined; } },
      set(k, v) {
        const txt = JSON.stringify(v);
        try { localStorage.setItem(CK + k, txt); }
        catch (e) {   // phone storage full: drop the saved copies (never the outbox) and try once more
          try { Object.keys(localStorage).filter((x) => x.startsWith(CK)).forEach((x) => localStorage.removeItem(x)); localStorage.setItem(CK + k, txt); } catch (e2) {}
        }
      },
    };
    let outbox = []; try { outbox = JSON.parse(localStorage.getItem(OUTBOX) || "[]"); } catch (e) { outbox = []; }
    const saveOutbox = () => { try { localStorage.setItem(OUTBOX, JSON.stringify(outbox)); } catch (e) {} status(); };
    // same rule as the database's jsonb_deep_merge: objects merge key by key, anything else (null included) replaces
    const deepMerge = (a, b) => {
      if (!a || typeof a !== "object" || Array.isArray(a) || !b || typeof b !== "object" || Array.isArray(b)) return b;
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
      return out;
    };
    // what a record looks like once this phone's waiting changes land
    const withPending = (path, row) => {
      let data = row ? row.data : undefined, gone = false;
      for (const op of outbox) if (op.path === path) {
        if (op.kind === "delete") { data = undefined; gone = true; }
        else if (op.kind === "upsert") { data = op.data; gone = false; }
        else { data = data === undefined ? op.data : deepMerge(data, op.data); gone = false; }
      }
      return data === undefined || gone ? null : { path, data };
    };
    const pendingChildren = (parent) => [...new Set(outbox.map((o) => o.path).filter((p) => parentOf(p) === parent))];
    // ---- signing in: the code is checked on the server, which hands back a signed token for this phone ----
    const TOKEN = "ss51-token", ME = "ss51-scout";
    const token = () => { try { return localStorage.getItem(TOKEN) || ""; } catch (e) { return ""; } };
    // a phone signed in the old way (no token) signs in again once
    try { if (!token()) localStorage.removeItem(ME); } catch (e) {}
    const FN = cfg.url.replace(/\/$/, "") + "/functions/v1/board";
    async function callBoard(body, withToken) {
      let res;
      // a change waiting in the outbox goes up as the scout who made it, even if someone else signed in since
      const tok = typeof withToken === "string" ? withToken : withToken ? token() : "";
      try { res = await fetch(FN, { method: "POST", headers: { apikey: cfg.key, "Content-Type": "application/json", ...(tok ? { "x-scout-token": tok } : {}) }, body: JSON.stringify(body) }); }
      catch (e) { throw { code: "offline", message: String(e && e.message || e) }; }
      let out = null; try { out = await res.json(); } catch (e) {}
      return { status: res.status, out: out || {} };
    }
    window.SITE.signIn = async (code) => {
      let r; try { r = await callBoard({ action: "signin", code }, false); } catch (e) { return { error: "Can't reach the team database. Check the connection and try again." }; }
      if (r.status !== 200 || !r.out.token) return { error: r.out.message || "Couldn't sign in. Try again." };
      try { localStorage.setItem(TOKEN, r.out.token); } catch (e) {}
      setTimeout(flush, 0);
      return { id: r.out.id, name: r.out.name };
    };
    window.SITE.signOut = () => { try { localStorage.removeItem(TOKEN); } catch (e) {} };
    // photos: sent (already shrunk by the page) to the board function, which stores them and returns the address
    window.SITE.uploadPhoto = async (path, blob) => {
      if (!navigator.onLine) throw { code: "offline", message: "No connection." };
      const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
      const res = await callBoard({ action: "upload", path, type: blob.type || "image/jpeg", data }, true);
      if (res.status === 200 && res.out.url) return res.out.url;
      if (res.status === 401) throw { code: "signin", message: res.out.message || "Sign in again to add photos." };
      throw { code: "upload", message: res.out.message || "The photo couldn't be uploaded." };
    };
    // one change, through the server's checks
    async function sendOp(op) {
      const r = await callBoard({ action: "write", ops: [{ kind: op.kind, path: op.path, data: op.data }] }, op.token || true);
      if (r.status === 200) return;
      if (r.status === 401) throw { code: "signin", message: r.out.message || "Sign in again." };
      if (r.status === 403) throw { code: "invalid_argument", message: r.out.message || "Not allowed." };
      if (r.status >= 500 || r.status === 0) throw { code: "offline", message: r.out.message || "Server busy." };
      throw { code: "invalid_argument", message: r.out.message || "Not allowed." };
    }
    function signedOut(message) {
      try { localStorage.removeItem(TOKEN); localStorage.removeItem(ME); } catch (e) {}
      // changes waiting in the outbox stay on this phone and upload after signing in again
      alertOnce = message || "Sign in again with your scout code. Your waiting changes are kept on this phone.";
      status(); setTimeout(() => location.reload(), 1800);
    }
    let alertOnce = "";
    let syncing = false, refused = 0;
    async function flush() {
      if (syncing || !outbox.length || !navigator.onLine) return;
      syncing = true; status();
      try {
        while (outbox.length) {
          const op = outbox[0];
          if (!token() && !op.token) break;                // not signed in: keep everything until they are
          try { await sendOp(op); }
          catch (e) {
            if (e && e.code === "offline") break;          // still no signal: keep everything, try again later
            if (e && e.code === "signin") { if (op.token) { delete op.token; saveOutbox(); } signedOut(e.message); break; }   // expired: retry with the next sign-in
            refused++;                                    // the server refused it: drop it so the rest can go
          }
          outbox.shift(); saveOutbox(); onChange(op.path);
        }
      } finally { syncing = false; status(); }
    }
    // run a change now, or keep it in the outbox when there's no signal
    async function write(kind, path, data) {
      if (outbox.length || !navigator.onLine) { queue(kind, path, data); return; }
      try { await sendOp({ kind, path, data }); }
      catch (e) {
        if (e && e.code === "offline") { queue(kind, path, data); return; }
        if (e && e.code === "signin") { queue(kind, path, data); signedOut(e.message); return; }
        throw e;
      }
      onChange(path);
    }
    function queue(kind, path, data) {
      outbox.push({ kind, path, data, at: Date.now(), token: token() || undefined }); saveOutbox();
      onChange(path); setTimeout(flush, 0);
    }
    window.addEventListener("online", () => { status(); flush(); });
    window.addEventListener("offline", status);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
    setInterval(flush, 15000);

    // small status pill: shows only when offline or when changes are waiting
    let pill = null;
    function status() {
      if (!document.body) { document.addEventListener("DOMContentLoaded", status, { once: true }); return; }
      if (!pill) {
        pill = document.createElement("div"); pill.id = "syncPill"; pill.setAttribute("role", "status"); pill.setAttribute("aria-live", "polite");
        pill.style.cssText = "position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:60;max-width:calc(100vw - 24px);padding:7px 12px;border-radius:999px;font:600 13px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 6px 18px rgb(20 6 50 / .35);color:#fff;background:#1b0f33;border:1px solid #7c3aed";
        document.body.appendChild(pill);
      }
      const n = outbox.length, off = !navigator.onLine;
      let text = "";
      if (alertOnce) text = alertOnce;
      else if (off) text = n ? `Offline · ${n} change${n === 1 ? "" : "s"} saved on this phone, will upload when you're back online` : "Offline · showing what was last loaded. Notes you write will upload later.";
      else if (n) text = syncing ? `Uploading ${n} change${n === 1 ? "" : "s"}…` : `${n} change${n === 1 ? "" : "s"} waiting to upload…`;
      else if (refused) { text = `${refused} change${refused === 1 ? "" : "s"} made offline couldn't be saved.`; setTimeout(() => { refused = 0; status(); }, 8000); }
      pill.textContent = text; pill.hidden = !text;
      pill.style.background = off ? "#3b0764" : refused && !n ? "#7f1d1d" : "#1b0f33";
      window.SITE.sync = { offline: off, pending: n };
    }
    window.SITE.flush = flush;

    // ---- live updates: one Realtime channel for the whole table; each listener re-reads
    // what it watches when a matching row changes. A slow poll covers any missed message.
    const docWatch = new Map();   // path   -> Set(refresh fn)
    const colWatch = new Map();   // parent -> Set(refresh fn)
    const fire = (map, key) => { const s = map.get(key); if (s) s.forEach((fn) => fn()); };
    const onChange = (path) => { if (!path) return; fire(docWatch, path); fire(colWatch, parentOf(path)); };
    sb.channel("board-docs")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (msg) => onChange((msg.new && msg.new.path) || (msg.old && msg.old.path)))
      .subscribe((status) => { if (status === "SUBSCRIBED") { docWatch.forEach((s) => s.forEach((fn) => fn())); colWatch.forEach((s) => s.forEach((fn) => fn())); } });
    setInterval(() => { if (document.hidden) return; docWatch.forEach((s) => s.forEach((fn) => fn())); colWatch.forEach((s) => s.forEach((fn) => fn())); }, 30000);

    function watch(map, key, load, next, error) {
      let alive = true, last, running = false, again = false;
      const run = async () => {
        if (!alive) return;
        if (running) { again = true; return; }
        running = true;
        try { const snap = await load(); const sig = JSON.stringify(snap.sig); if (alive && sig !== last) { last = sig; next(snap.value); } }
        catch (e) { if (alive && error && e && e.code === "invalid_argument") { alive = false; error(e); } }
        running = false;
        if (again) { again = false; run(); }
      };
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(run);
      run();
      return () => { alive = false; map.get(key)?.delete(run); };
    }

    function docRef(path) {
      // read the record; with no signal, use this phone's copy. Waiting changes are shown on top either way.
      const getRow = async () => {
        let row;
        try { row = (await check(sb.from("docs").select("path,data").eq("path", path).maybeSingle())) || null; store.set("doc:" + path, row); }
        catch (e) { if (e.code !== "offline") throw e; row = store.get("doc:" + path); if (row === undefined && !outbox.some((o) => o.path === path)) throw e; }
        return withPending(path, row || null);
      };
      return {
        id: path.split("/").pop(), path,
        get: async () => snapOf(path, await getRow()),
        // competition, team and match records are never replaced wholesale, only merged into, so a page that
        // hasn't finished loading can't wipe out notes and ratings by writing a fresh copy over them
        set: async (data) => {
          await write(path.startsWith("events/") ? "merge" : "upsert", path, data);
        },
        // nested objects merge (notes, ratings); done in the database so simultaneous saves don't clash
        update: async (data) => write("merge", path, data),
        delete: async () => write("delete", path, null),
        onSnapshot: (next, error) => watch(docWatch, path, async () => { const row = await getRow(); return { sig: row && row.data, value: snapOf(path, row) }; }, next, error),
        collection: (sub) => colRef(path + "/" + sub),
      };
    }
    function colRef(path) {
      const rows = async () => {
        let list;
        try { list = (await check(sb.from("docs").select("path,data").eq("parent", path).order("path").limit(1000))) || []; store.set("col:" + path, list); }
        catch (e) { if (e.code !== "offline") throw e; list = store.get("col:" + path); if (list === undefined) throw e; }
        const waiting = pendingChildren(path);
        if (!waiting.length) return list;
        const byPath = new Map(list.map((r) => [r.path, r]));
        for (const p of waiting) { const r = withPending(p, byPath.get(p) || null); if (r) byPath.set(p, r); else byPath.delete(p); }
        return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
      };
      const query = (list) => { const docs = list.map((r) => snapOf(r.path, r)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta }; };
      return {
        path,
        doc: (id) => docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))),
        add: async (data) => { const ref = docRef(path + "/" + Math.random().toString(36).slice(2, 12)); await ref.set(data); return ref; },
        get: async () => query(await rows()),
        onSnapshot: (next, error) => watch(colWatch, path, async () => { const list = await rows(); return { sig: list, value: query(list) }; }, next, error),
      };
    }
    db = { doc: docRef, collection: colRef };

    // AI overview of a team's scouting: the server function builds the prompt from the
    // database and saves the result on the team, so this only names which team.
    // Switched OFF for now (paid API). To turn it on: set AI_OVERVIEW = true, rebuild with
    // AI_OVERVIEW in tools/build-site.py, and add ANTHROPIC_API_KEY in Supabase (README).
    // FIRST's official FTC Events API, through the ftc-events function (the login stays in Supabase)
    window.SITE.first = async (path) => {
      try {
        const { data, error } = await sb.functions.invoke("ftc-events", { body: { path } });
        if (error) throw error;
        store.set("first:" + path, data);
        return data;
      } catch (e) {
        const kept = store.get("first:" + path);
        if (kept !== undefined && (!navigator.onLine || isNetErr(e) || /fetch|relay|network/i.test(String(e && e.message)))) return kept;
        throw e;
      }
    };
    status(); setTimeout(flush, 2000);
    const AI_OVERVIEW = false;
    if (AI_OVERVIEW) window.SITE.recap = async (event, team, force) => {
      const { data, error } = await sb.functions.invoke("team-recap", { body: { event, team, force: !!force } });
      if (!error) return data;
      try { const body = await error.context.json(); if (body && body.error) return body; } catch (e) {}
      return { error: "ai_error" };
    };
  }

  let deviceId = "";
  try { deviceId = localStorage.getItem("ss51-device") || ""; if (!deviceId) { deviceId = "d_" + Math.random().toString(36).slice(2, 12); localStorage.setItem("ss51-device", deviceId); } } catch (e) { deviceId = "d_" + Math.random().toString(36).slice(2, 12); }
  const user = {
    id: async () => deviceId,
    isOwner: async () => false,      // leads are decided by the roster on the website
    can: async () => true,
    canEdit: async () => false,
    profiles: async (ids) => Object.fromEntries(ids.map((i) => [i, { id: i, name: "", isMe: false }])),
  };
  const caps = { db, user, mcp: {} };
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  window.claude = { use: (name) => Promise.resolve(caps[name] || null) };
})();
