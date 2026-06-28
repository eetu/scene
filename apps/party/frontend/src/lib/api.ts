// Thin fetch layer over the backend's JSON API. Types are hand-written to match
// the Rust structs (no codegen — see sibling-app). Keep in sync with
// backend/src/routes.rs.

export type Party = {
  slug: string;
  name: string;
  year: number | null;
  location: string | null;
  organizer: string | null;
  n_productions: number;
  n_files: number;
  logo_hash: string | null;
  logo_kind: string | null;
};

/** A competition entry as shown in a party's catalog. */
export type Production = {
  id: string;
  category: string;
  compo: string;
  platform: string; // pc | amiga | c64 | video | na
  medium: string; // demo | intro | music | graphics | animation | info
  rank: number | null;
  group: string | null;
  title: string | null;
  points: number | null;
  primary_hash: string | null;
  primary_kind: string | null; // music | image | video | exe | diskimage | text | …
  primary_filename: string | null;
  n_files: number;
};

export type ProductionFile = {
  hash: string;
  rel_path: string;
  filename: string;
  ext: string;
  kind: string;
  mime: string;
  size: number;
};

/** libopenmpt enrichment for the primary music file (null until parsed). */
export type MusicMeta = {
  title: string | null;
  type_long: string | null;
  tracker: string | null;
  duration: number | null;
  channels: number | null;
  instruments: number | null;
  samples: number | null;
  n_orders: number | null;
  n_patterns: number | null;
};

export type ProductionDetail = {
  production: Production & { party_slug: string; primary_rel: string | null };
  files: ProductionFile[];
  meta: MusicMeta | null;
};

export type StatusResponse = {
  service: string;
  version: string;
  db_healthy: boolean;
  file_count: number | null;
  production_count: number | null;
  party_count: number | null;
  root: string | null; // redacted (null) in kiosk mode
  kiosk: boolean; // public read-only deploy: no rescan/operator actions
  scanning: boolean;
  scan_total: number;
  scan_processed: number;
  scan_hashed: number;
};

export type RescanResult = {
  indexed: number;
  hashed: number;
  removed: number;
  productions: number;
  parties: number;
};

/** Metadata the frontend parses via libopenmpt WASM and writes back. */
export type MetaIn = {
  title?: string | null;
  type_long?: string | null;
  tracker?: string | null;
  duration?: number | null;
  channels?: number | null;
  instruments?: number | null;
  samples?: number | null;
  n_orders?: number | null;
  n_patterns?: number | null;
};

/** Thrown for any non-2xx response; carries the HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    ...init,
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} → ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => request<StatusResponse>("/status"),
  parties: () => request<{ parties: Party[] }>("/api/parties").then((r) => r.parties),
  productions: (slug: string) =>
    request<{ productions: Production[]; kickstart_url: string | null }>(
      `/api/parties/${slug}/productions`,
    ),
  production: (id: string) => request<ProductionDetail>(`/api/production/${id}`),
  text: (hash: string) => fetch(`/api/text/${hash}`).then((r) => r.text()),
  rescan: () => request<RescanResult>("/api/rescan", { method: "POST" }),
  putMeta: (hash: string, meta: MetaIn) =>
    request<void>(`/api/meta/${hash}`, { method: "POST", body: JSON.stringify(meta) }),
};

/** URL for the raw file bytes (player + WASM metadata + download). */
export function fileUrl(hash: string): string {
  return `/api/file/${hash}`;
}

/** File bytes with the real filename in the URL — emulators (EmulatorJS/PUAE)
 *  read both the disk format (.adf/.hdf/.d64) and the model marker ("(AGA)" →
 *  A1200) off the filename, which the bare hash lacks. */
export function diskUrl(hash: string, filename: string | null): string {
  // encodeURI (not …Component) so spaces become %20 but the "(AGA)" model
  // marker's parentheses stay literal for PUAE's filename detection.
  return `/api/file/${hash}/${encodeURI(filename || "disk.bin")}`;
}

/** URL for a derived (transcoded) asset — `png` for non-native images, `mp4`
 *  for non-native video. Transcoded on demand by the backend + sidecar. */
export function assetUrl(hash: string, target: "png" | "mp4"): string {
  return `/api/asset/${hash}.${target}`;
}

/** URL for a production's js-dos bundle (PC demos/intros). The `v` is the
 *  dosbox.conf revision — bump it whenever the backend's generated config
 *  changes, so the browser + js-dos caches fetch the new bundle instead of a
 *  stale one. */
const BUNDLE_CONF_VERSION = 2;
export function bundleUrl(prodId: string): string {
  return `/api/bundle/${prodId}.jsdos?v=${BUNDLE_CONF_VERSION}`;
}
