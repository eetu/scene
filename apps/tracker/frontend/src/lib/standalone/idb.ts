// Tiny promise wrapper over IndexedDB — one object store of module bytes keyed
// by content hash, so a dropped set survives a reload (localStorage can't hold
// binary at this size). Browser-only; callers guard with `browser`.
const DB_NAME = "tracker-standalone";
const STORE = "modules";
const VERSION = 1;

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const put = (key: string, buf: ArrayBuffer): Promise<void> =>
  tx<void>("readwrite", (s) => s.put(buf, key));

export const get = (key: string): Promise<ArrayBuffer | undefined> =>
  tx<ArrayBuffer | undefined>("readonly", (s) => s.get(key));

export const del = (key: string): Promise<void> => tx<void>("readwrite", (s) => s.delete(key));

export const keys = (): Promise<string[]> =>
  tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((ks) => ks.map(String));
