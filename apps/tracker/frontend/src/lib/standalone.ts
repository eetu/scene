// Build-mode flag for the backend-less GitHub Pages build. Set at build time via
// `VITE_STANDALONE=1` (see the pages workflow); undefined → false for the normal
// backend-embedded build. When true, the app has no `/api` — the library comes
// from files the user drops / picks, bytes live in IndexedDB, and the catalog +
// favourites + playlists persist in localStorage (see standalone/store).
export const STANDALONE = import.meta.env.VITE_STANDALONE === "1";

// Module extensions libopenmpt can play — used to filter dropped folders / zip
// entries and to build the file-picker `accept`. Permissive on purpose; a file
// that slips through and fails to parse is just skipped.
export const MODULE_EXTS = [
  "mod",
  "xm",
  "s3m",
  "it",
  "mptm",
  "stm",
  "nst",
  "m15",
  "stk",
  "wow",
  "ult",
  "669",
  "mtm",
  "med",
  "far",
  "mdl",
  "ams",
  "dsm",
  "dsym",
  "amf",
  "okt",
  "okta",
  "dmf",
  "ptm",
  "psm",
  "mt2",
  "dbm",
  "digi",
  "imf",
  "j2b",
  "gdm",
  "umx",
  "plm",
  "sfx",
  "sfx2",
  "mms",
  "c67",
  "fmt",
  "symmod",
  "gtk",
  "gt2",
  "fc",
  "fc13",
  "fc14",
  "smod",
  "mod15",
  "st26",
  "ice",
  "etx",
  "puma",
  "tcb",
];

const EXT_SET = new Set(MODULE_EXTS);

/** The file extension (lowercased, no dot) of a name/path, or "". */
export function extOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Does this filename look like a playable module? */
export function isModule(name: string): boolean {
  return EXT_SET.has(extOf(name));
}

/** The file-picker `accept` string (dotted extensions + zip). */
export const ACCEPT = [...MODULE_EXTS.map((e) => `.${e}`), ".zip"].join(",");
