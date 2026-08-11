// What survives a reload: the folder you saved into, the file you had open, and
// any unsaved work.
//
// The dev server reloads the page on every edit to the editor's own source, and
// picking the sprites folder again each time — then losing the drawing that was
// in progress — is the difference between a tool you use and one you fight. A
// directory handle is structured-cloneable, so IndexedDB can hold the real
// thing; the draft is JSON in localStorage.

import { fromJson, type SpriteFile, toJson } from "@scene/player/sprite-file";

const DB_NAME = "sprite-editor";
const STORE = "handles";
const FOLDER_KEY = "folder";
const FILE_KEY = "sprite-editor:file";
const DRAFT_KEY = "sprite-editor:draft";

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!("indexedDB" in globalThis)) return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => resolve(null);
      }),
  );
}

/** Remember the picked folder. The handle itself, not a path — a path would be
 *  useless, since the browser will only ever hand back access via the handle. */
export const rememberFolder = (handle: unknown): Promise<unknown> =>
  tx("readwrite", (s) => s.put(handle, FOLDER_KEY));

export const recallFolder = <T>(): Promise<T | null> => tx<T>("readonly", (s) => s.get(FOLDER_KEY));

export const forgetFolder = (): Promise<unknown> => tx("readwrite", (s) => s.delete(FOLDER_KEY));

// ---------- the open file, and unsaved work ----------

export function rememberFile(file: string | null) {
  try {
    if (file) localStorage.setItem(FILE_KEY, file);
    else localStorage.removeItem(FILE_KEY);
  } catch {
    /* private mode; the editor still works, it just forgets */
  }
}

export function recallFile(): string | null {
  try {
    return localStorage.getItem(FILE_KEY);
  } catch {
    return null;
  }
}

/**
 * The unsaved document.
 *
 * Kept separately from the file list so a reload mid-drawing comes back to the
 * drawing rather than to the last saved state — losing work to a hot reload is
 * the one failure this tool must not have.
 */
export function rememberDraft(sprite: SpriteFile, file: string | null) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ file, sprite: toJson(sprite) }));
  } catch {
    /* quota or private mode — nothing to do but carry on */
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

export function recallDraft(): { file: string | null; sprite: SpriteFile } | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const held = JSON.parse(raw) as { file: string | null; sprite: string };
    const parsed = fromJson(held.sprite);
    // A draft that no longer parses is dropped rather than resurrected: the
    // format may have moved on since it was written.
    if ("errors" in parsed) return null;
    return { file: held.file, sprite: parsed.sprite };
  } catch {
    return null;
  }
}
