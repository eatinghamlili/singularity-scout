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
    async function check(promise) { const { data, error } = await promise; if (error) throw mapErr(error); return data; }

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
      const getRow = async () => (await check(sb.from("docs").select("path,data").eq("path", path).maybeSingle())) || null;
      return {
        id: path.split("/").pop(), path,
        get: async () => snapOf(path, await getRow()),
        set: async (data) => { await check(sb.from("docs").upsert({ path, data, updated_at: new Date().toISOString() })); onChange(path); },
        // nested objects merge (notes, ratings); done in the database so simultaneous saves don't clash
        update: async (data) => { await check(sb.rpc("merge_doc", { p_path: path, p_patch: data })); onChange(path); },
        delete: async () => { await check(sb.from("docs").delete().eq("path", path)); onChange(path); },
        onSnapshot: (next, error) => watch(docWatch, path, async () => { const row = await getRow(); return { sig: row && row.data, value: snapOf(path, row) }; }, next, error),
        collection: (sub) => colRef(path + "/" + sub),
      };
    }
    function colRef(path) {
      const rows = async () => (await check(sb.from("docs").select("path,data").eq("parent", path).order("path").limit(1000))) || [];
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
  window.claude = { use: (name) => Promise.resolve(caps[name] || null) };
})();
