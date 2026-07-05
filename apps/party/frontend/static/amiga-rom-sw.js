// Service worker: serves user-supplied Amiga Kickstart ROMs from IndexedDB at
// /amiga-rom/<filename>. EmulatorJS/PUAE only accept a ROM via a real same-origin
// URL whose basename is the exact Kickstart filename (an in-FS write is ignored
// unless a bios was already configured). This lets the SPA hand the visitor's own
// ROM to EJS_biosUrl without ever uploading it to the server. See amigaRoms.ts.
const DB_NAME = "party-amiga-roms";
const STORE = "roms";
const PREFIX = "/amiga-rom/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function getRom(name) {
  return new Promise((resolve) => {
    let db;
    const req = indexedDB.open(DB_NAME, 1);
    req.onsuccess = () => {
      db = req.result;
      try {
        const g = db.transaction(STORE, "readonly").objectStore(STORE).get(name);
        g.onsuccess = () => resolve(g.result || null);
        g.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    };
    req.onerror = () => resolve(null);
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  const name = decodeURIComponent(url.pathname.slice(PREFIX.length));
  event.respondWith(
    getRom(name).then((buf) =>
      buf
        ? new Response(buf, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(buf.byteLength),
              "Cache-Control": "no-store",
            },
          })
        : new Response("Kickstart ROM not provided", { status: 404 }),
    ),
  );
});
