// Client-side Amiga Kickstart ROMs. ROMs are copyrighted and not shipped by every
// deployment; when the server lacks the ROM a demo needs, the visitor supplies
// their own file, we validate it by CRC32, keep it in IndexedDB (never uploaded),
// and inject it straight into the emulator's filesystem. See EjsEmulator.svelte.

/** The ROMs the app knows how to use, keyed by the exact filename PUAE expects in
 * its system dir (the emulator FS root). crc = expected CRC32 of the raw dump. */
export const KNOWN_ROMS: Record<string, { crc: number; label: string; size: number }> = {
  "kick34005.A500": { crc: 0xc4f0f55f, label: "Kickstart 1.3 (A500)", size: 262144 },
  "kick40068.A1200": { crc: 0x1483a091, label: "Kickstart 3.1 (A1200)", size: 524288 },
  "kick40068.A4000": { crc: 0xd6bae334, label: "Kickstart 3.1 (A4000)", size: 524288 },
};

// CRC32 (IEEE, same polynomial as zlib/PUAE's ROM check).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// IndexedDB store: one object store keyed by ROM filename, value = the raw bytes.
const DB_NAME = "party-amiga-roms";
const STORE = "roms";

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

/** Load every stored ROM as { filename: bytes }. Empty object if IDB is blocked. */
export async function loadStoredRoms(): Promise<Record<string, Uint8Array>> {
  if (typeof indexedDB === "undefined") return {};
  try {
    const db = await openDb();
    return await new Promise((res) => {
      const out: Record<string, Uint8Array> = {};
      const tx = db.transaction(STORE, "readonly").objectStore(STORE);
      const cur = tx.openCursor();
      cur.onsuccess = () => {
        const cursor = cur.result;
        if (!cursor) return res(out);
        out[String(cursor.key)] = new Uint8Array(cursor.value as ArrayBuffer);
        cursor.continue();
      };
      cur.onerror = () => res(out);
    });
  } catch {
    return {};
  }
}

export async function storeRom(name: string, bytes: Uint8Array): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    // store a copy of the raw buffer (structured-clone friendly)
    tx.objectStore(STORE).put(bytes.slice().buffer, name);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function removeRom(name: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(name);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// A ROM must reach PUAE through EmulatorJS's normal bios path — a real same-origin
// URL whose basename is the exact Kickstart filename (writing it into the emulator
// FS by hand does NOT work unless a bios was already configured). So a service
// worker serves user ROMs from IndexedDB at /amiga-rom/<name>; EJS_biosUrl points
// there and the ROM never leaves the browser. Returns whether the SW controls the
// page (so a user ROM can actually be served).
export async function ensureRomSW(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register("/amiga-rom-sw.js");
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return true;
    // First registration this origin: wait for the SW to claim this page.
    await new Promise<void>((res) => {
      const done = () => res();
      navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
      setTimeout(done, 3000);
    });
    return !!navigator.serviceWorker.controller;
  } catch {
    return false;
  }
}

export const userRomUrl = (name: string) => `/amiga-rom/${encodeURIComponent(name)}`;
