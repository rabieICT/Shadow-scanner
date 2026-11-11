// Keeps the app's own files on the phone so it opens instantly and works offline (Supabase calls are never cached).
const CACHE = "shadow-scanner-v7";
const FILES = ["./", "index.html", "app.js", "app.css", "config.js", "manifest.webmanifest", "icon.svg", "entries.html", "entries.js", "entries.webmanifest"];

// "reload" / "no-cache" skip the browser's own HTTP cache, so GitHub Pages' short cache can't hand back an old app.js.
self.addEventListener("install", (e) => e.waitUntil(
  caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

// Cached copy first (fast), refreshed in the background so a new version arrives at the next opening.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request, { cache: "no-cache" }).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => cached);
    return cached || fresh;
  }));
});
