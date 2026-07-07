// Bulk metadata enrichment, extracted from +page.svelte so the loop + payload
// mapping are node-unit-testable. Parses every un-enriched module's metadata via
// the WASM decoder and writes it back to the backend cache; dependency-injected
// so tests run without fetch / the worklet / the network.
import type { ParsedMeta } from "@scene/player";

import type { MetaIn, Track } from "$lib/api";

export type EnrichDeps = {
  fetchBytes: (hash: string) => Promise<ArrayBuffer>;
  parse: (buf: ArrayBuffer) => Promise<ParsedMeta | null>;
  save: (hash: string, meta: MetaIn) => Promise<void>;
};

export type EnrichHooks = {
  /** Return false to stop early (user cancelled). Checked before each module. */
  shouldContinue: () => boolean;
  /** Called with the running count after each module (ok, skipped, or error). */
  onProgress: (done: number) => void;
};

/** Map parsed WASM metadata → the backend's meta payload. */
export function toMeta(m: ParsedMeta): MetaIn {
  return {
    title: m.title || null,
    type_long: m.type_long || null,
    tracker: m.tracker || null,
    duration: m.dur ?? null,
    channels: m.channels ?? null,
    instruments: m.instruments ?? null,
    samples: m.samples ?? null,
    n_orders: m.orders ?? null,
    n_patterns: m.patterns ?? null,
  };
}

/** Reflect saved metadata onto the (reactive) track so its row updates live. */
function apply(t: Track, meta: MetaIn) {
  t.title = meta.title ?? null;
  t.type_long = meta.type_long ?? null;
  t.tracker = meta.tracker ?? null;
  t.duration = meta.duration ?? null;
  t.channels = meta.channels ?? null;
  t.instruments = meta.instruments ?? null;
  t.samples = meta.samples ?? null;
}

/** Parse + persist metadata for each track in `todo`, in order. Skips modules
 *  that fail (keeps going), stops early when `shouldContinue()` turns false, and
 *  reports progress after every module. */
export async function enrichTracks(
  todo: Track[],
  deps: EnrichDeps,
  hooks: EnrichHooks,
): Promise<void> {
  let done = 0;
  for (const t of todo) {
    if (!hooks.shouldContinue()) break;
    try {
      const m = await deps.parse(await deps.fetchBytes(t.hash));
      if (m) {
        const meta = toMeta(m);
        await deps.save(t.hash, meta);
        apply(t, meta);
      }
    } catch {
      /* skip this module, keep going */
    }
    hooks.onProgress(++done);
  }
}
