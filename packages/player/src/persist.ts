// localStorage that may be absent or throwing (SSR, private mode, storage
// disabled): reads fall back to null, writes drop silently.

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // no storage — fall through to the default
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage — the choice just won't outlive the session */
  }
}
