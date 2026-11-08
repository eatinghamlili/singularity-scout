// Keeps Singularity Scout's own files on the phone so the site opens with no signal.
// The page and its scripts: try the network first (so updates show up right away), but give up
// after a few seconds on weak venue Wi-Fi and use the saved copy. Fonts and the Supabase library
// rarely change, so they come from the saved copy first. FTCScout's public data is saved as it's
// read, so the last schedule and stats still show offline. Database requests are left alone:
// platform.js keeps its own copy of the data and an outbox for changes.
const VERSION = "ss51-v1";
const SHELL = ["./", "index.html", "platform.js", "supabase-config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const timeout = (ms) => new Promise((_, no) => setTimeout(() => no(new Error("slow")), ms));
async function networkFirst(req, ms) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([fetch(req), timeout(ms)]);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" }) || (req.mode === "navigate" ? await cache.match("index.html") : null);
    if (hit) return hit;
    throw e;
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;                       // the database: handled by platform.js
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req, 4000)); return; }
  if (url.hostname === "api.ftcscout.org") { e.respondWith(networkFirst(req, 6000)); return; }
  if (/(^|\.)fonts\.(googleapis|gstatic)\.com$|^cdn\.jsdelivr\.net$/.test(url.hostname)) { e.respondWith(cacheFirst(req)); return; }
});
