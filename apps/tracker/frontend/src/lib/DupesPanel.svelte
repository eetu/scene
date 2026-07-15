<script lang="ts">
  // Duplicate-cleanup overlay. Fetches the backend's /api/dupes report (exact =
  // identical bytes at several paths; likely = same filename, different content)
  // and lets the user permanently delete individual files to clean them up.
  // Deletes are destructive (hard remove on disk), so each is a two-step inline
  // confirm rather than a one-tap button.
  import { RefreshCw, Trash2, X } from "@lucide/svelte";
  import { playback, playInOrder, transportToggle } from "@scene/player";
  import { onMount } from "svelte";

  import { api, type DupeFile, type DupesReport } from "$lib/api";
  import { library, removeTrackLocal } from "$lib/library.svelte";
  import Modal from "$lib/Modal.svelte";

  let {
    onClose,
    onToast,
  }: { onClose: () => void; onToast: (msg: string, kind?: "ok" | "err") => void } = $props();

  let loading = $state(true);
  let report = $state<DupesReport | null>(null);
  // Path awaiting delete confirmation (only one row confirms at a time).
  let confirmPath = $state<string | null>(null);
  let deleting = $state(false);

  const empty = $derived(!report || (report.exact.length === 0 && report.likely.length === 0));

  async function load() {
    loading = true;
    confirmPath = null;
    try {
      report = await api.dupes();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), "err");
    } finally {
      loading = false;
    }
  }
  onMount(load);

  const nameOf = (path: string) => path.split("/").pop() ?? path;
  const dirOf = (path: string) => path.split("/").slice(0, -1).join(" / ");

  // Preview a duplicate to compare before deleting. The report carries path+md5
  // but not the content hash the player fetches by, so resolve the full track
  // from the (full) library index by path. Plays without opening the pattern
  // view, so the dialog stays up; clicking the current track toggles play/pause.
  const isPlaying = (path: string) => playback.current?.path === path;
  function onFile(path: string) {
    if (isPlaying(path)) {
      transportToggle();
      return;
    }
    const t = library.tracks.find((x) => x.path === path);
    if (t) void playInOrder([t], t);
    else onToast("couldn't find that file in the library index", "err");
  }

  // Drop the just-deleted path from the local report so the list updates without
  // a re-fetch: an exact set stops being a dupe below 2 copies; a likely set once
  // it no longer spans >1 distinct md5 (mirrors the backend's definition).
  function pruneAfterDelete(path: string) {
    if (!report) return;
    report = {
      exact: report.exact
        .map((g) => ({ ...g, paths: g.paths.filter((p) => p !== path) }))
        .filter((g) => g.paths.length > 1),
      likely: report.likely
        .map((g) => ({ ...g, files: g.files.filter((f) => f.path !== path) }))
        .filter((g) => new Set(g.files.map((f) => f.md5)).size > 1),
    };
  }

  async function deleteOne(path: string) {
    deleting = true;
    try {
      await api.deleteTrack(path);
      removeTrackLocal(path); // reflect in the main library list too
      pruneAfterDelete(path);
      onToast(`deleted ${nameOf(path)}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), "err");
    } finally {
      deleting = false;
      confirmPath = null;
    }
  }
</script>

{#snippet fileRow(path: string, file?: DupeFile)}
  {@const orphan = file && !file.favorite && file.play_count === 0 && file.playlists.length === 0}
  <li title={path} class:current={isPlaying(path)} class:orphan>
    <button class="f" onclick={() => onFile(path)} title="play {nameOf(path)}">
      {#if dirOf(path)}<span class="dir">{dirOf(path)} / </span>{/if}<span class="name"
        >{nameOf(path)}</span
      >
      {#if file}
        <span class="md5">{file.md5.slice(0, 8)}</span>
        {#if file.favorite}<span class="badge fav" title="favourite">★</span>{/if}
        {#if file.play_count > 0}
          <span class="badge" title="{file.play_count} plays">▶ {file.play_count}</span>
        {/if}
        {#each file.playlists as pl (pl)}
          <span class="badge list" title="in playlist “{pl}”">{pl}</span>
        {/each}
        {#if orphan}<span class="badge unused" title="not favourited, played, or in any playlist"
            >unused</span
          >{/if}
      {/if}
    </button>
    <button
      class="mini"
      title="delete this file"
      aria-label="delete {nameOf(path)}"
      onclick={() => (confirmPath = path)}
    >
      <Trash2 size={13} />
    </button>
    <!-- Confirm overlays the row (position:absolute) rather than replacing the
         trash button inline, so opening it doesn't reflow the filename. -->
    {#if confirmPath === path}
      <div class="confirm">
        <span class="cfm">delete?</span>
        <button class="mini danger" onclick={() => deleteOne(path)} disabled={deleting}>yes</button>
        <button class="mini" onclick={() => (confirmPath = null)} disabled={deleting}>no</button>
      </div>
    {/if}
  </li>
{/snippet}

<Modal label="duplicates" {onClose}>
  <div class="head">
    <h3>duplicates</h3>
    <button class="icon-btn" onclick={load} disabled={loading} aria-label="rescan duplicates">
      <RefreshCw size={15} />
    </button>
    <button class="icon-btn" onclick={onClose} aria-label="close">
      <X size={16} />
    </button>
  </div>

  {#if loading}
    <p class="msg">scanning for duplicates…</p>
  {:else if empty}
    <p class="msg">No duplicates found — the collection is clean. 🎉</p>
  {:else}
    <div class="groups">
      {#if report && report.exact.length > 0}
        <h4>Identical files <span class="cnt">{report.exact.length}</span></h4>
        <p class="hint">
          Same bytes in more than one place — safe to keep one and delete the rest.
        </p>
        {#each report.exact as g (g.md5)}
          <ul class="set">
            {#each g.paths as p (p)}
              {@render fileRow(p)}
            {/each}
          </ul>
        {/each}
      {/if}

      {#if report && report.likely.length > 0}
        <h4>Same name, different content <span class="cnt">{report.likely.length}</span></h4>
        <p class="hint">Might be versions or unrelated tunes — check before deleting.</p>
        {#each report.likely as g (g.filename)}
          <div class="set">
            <div class="setname">{g.filename}</div>
            <ul>
              {#each g.files as f (f.path)}
                {@render fileRow(f.path, f)}
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  <div class="modal-actions">
    <button onclick={onClose}>close</button>
  </div>
</Modal>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .head h3 {
    flex: 1;
  }
  .msg {
    color: var(--muted);
    padding: 12px 0;
  }
  /* Scrollable region — the shared Modal has no max-height, so a long report
     would overflow the viewport. */
  .groups {
    max-height: min(60vh, 520px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 -4px;
    padding: 0 4px;
  }
  h4 {
    margin: 10px 0 2px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cnt {
    color: var(--text);
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    margin: 0 0 4px;
    font-size: 12px;
    color: var(--muted);
  }
  /* A dupe set = a card. */
  .set {
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    margin-bottom: 6px;
  }
  .setname {
    font-size: 12px;
    color: var(--muted);
    padding: 4px 0 2px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .set ul,
  ul.set {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 0 5px 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  }
  li:last-child {
    border-bottom: none;
  }
  /* Click-to-play: the filename is a button (strip the button chrome, keep it a
     single ellipsised line). */
  .f {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: none;
    padding: 2px 0;
    font: inherit;
    font-size: 13px;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .dir {
    color: var(--muted);
  }
  .name {
    color: var(--text);
  }
  /* Currently-playing row: accent the name. */
  li.current .name {
    color: var(--accent);
    font-weight: 600;
  }
  .md5 {
    margin-left: 6px;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  /* Membership badges — show which copy is referenced so the orphan is obvious. */
  .badge {
    margin-left: 5px;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--border);
    color: var(--muted);
    background: var(--panel);
    vertical-align: middle;
    white-space: nowrap;
  }
  .badge.fav {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .badge.list {
    color: var(--text);
  }
  .badge.unused {
    color: var(--muted);
    border-style: dashed;
    opacity: 0.8;
  }
  /* The safe-to-remove copy: nothing references it. Faint left accent, no shout. */
  li.orphan {
    background: color-mix(in srgb, var(--halo-error) 6%, transparent);
  }
  .mini {
    flex: 0 0 auto;
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    padding: 4px 6px;
  }
  .mini.danger {
    color: var(--halo-error);
  }
  .mini:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Delete confirmation, overlaid on the right of the row so it doesn't reflow
     the filename. Opaque card background covers the trash button beneath it, with
     a short fade on the left edge. */
  .confirm {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding-left: 24px;
    background: linear-gradient(to right, transparent, var(--panel-hi) 24px);
  }
  .cfm {
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--halo-error);
  }
</style>
