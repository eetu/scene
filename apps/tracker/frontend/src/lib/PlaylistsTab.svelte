<script lang="ts">
  import { ChevronDown, ChevronUp, Download, Play, Plus, Trash2, Upload, X } from "@lucide/svelte";
  import { playback } from "@scene/player";

  import {
    api,
    type FetchStatus,
    type ImportDoc,
    itemToTrack,
    type Playlist,
    type PlaylistDetail,
    type PlaylistItem,
    type Track,
  } from "$lib/api";
  import { STANDALONE } from "$lib/standalone";

  type Props = {
    playlists: Playlist[];
    /** Re-fetch the playlist list (after create/delete/rename/import). */
    onRefresh: () => Promise<void> | void;
    /** Play a list of present tracks in order, optionally starting at `start`. */
    onPlay: (tracks: Track[], start?: Track) => void;
    /** Surface a transient banner (shared app toast). */
    onToast: (msg: string, kind?: "ok" | "err") => void;
  };

  let { playlists, onRefresh, onPlay, onToast }: Props = $props();

  // Every action here talks to the backend; on failure surface it as an error
  // toast instead of silently swallowing it (the busy flag would just reset and
  // the user would see nothing happen).
  const fail = (e: unknown) => onToast(e instanceof Error ? e.message : String(e), "err");

  let newName = $state("");
  let detail = $state<PlaylistDetail | null>(null);
  let detailLoading = $state(false);
  let busy = $state(false);
  let importInput = $state<HTMLInputElement | undefined>(undefined);

  // Fetch-missing progress for the open playlist.
  let fetchp = $state<FetchStatus | null>(null);
  let fetching = $state(false);

  const missingCount = $derived(detail ? detail.items.filter((i) => !i.present).length : 0);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    busy = true;
    try {
      const pl = await api.createPlaylist(name);
      newName = "";
      await onRefresh();
      await openDetail(pl.id);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  async function openDetail(id: string) {
    detailLoading = true;
    try {
      detail = await api.getPlaylist(id);
    } catch (e) {
      fail(e);
    } finally {
      detailLoading = false;
    }
  }

  function closeDetail() {
    detail = null;
    detailLoading = false;
  }

  async function remove(id: string) {
    if (!confirm("Delete this playlist?")) return;
    busy = true;
    try {
      await api.deletePlaylist(id);
      if (detail?.playlist.id === id) detail = null;
      await onRefresh();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  async function rename(p: Playlist) {
    const name = prompt("Rename playlist", p.name)?.trim();
    if (!name || name === p.name) return;
    try {
      await api.renamePlaylist(p.id, name);
      await onRefresh();
      if (detail?.playlist.id === p.id) await openDetail(p.id);
    } catch (e) {
      fail(e);
    }
  }

  function playDetail() {
    if (!detail) return;
    const tracks = detail.items.filter((i) => i.present).map(itemToTrack);
    if (tracks.length) onPlay(tracks);
  }

  /** Play the playlist's present tracks, starting from the clicked item. */
  function playItem(it: PlaylistItem) {
    if (!detail || !it.present) return;
    const tracks = detail.items.filter((i) => i.present).map(itemToTrack);
    onPlay(tracks, itemToTrack(it));
  }

  /** Is this item the track currently loaded in the player? */
  function isCurrent(it: PlaylistItem): boolean {
    return it.present && !!playback.current && playback.current.path === it.path;
  }

  async function removeItem(itemId: number) {
    if (!detail) return;
    try {
      await api.removeFromPlaylist(detail.playlist.id, itemId);
      await openDetail(detail.playlist.id);
      await onRefresh();
    } catch (e) {
      fail(e);
    }
  }

  async function move(index: number, delta: number) {
    if (!detail) return;
    const ids = detail.items.map((i) => i.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    try {
      await api.reorderPlaylist(detail.playlist.id, ids);
      await openDetail(detail.playlist.id);
    } catch (e) {
      fail(e);
    }
  }

  async function fetchMissing() {
    if (!detail) return;
    fetching = true;
    try {
      await api.fetchMissing(detail.playlist.id);
      do {
        await new Promise((r) => setTimeout(r, 1000));
        fetchp = await api.fetchStatus();
      } while (fetchp.running);
      await openDetail(detail.playlist.id);
      await onRefresh();
    } catch (e) {
      fail(e);
    } finally {
      fetching = false;
    }
  }

  // ---- import / export (JSON documents — see api.ImportDoc) ----
  async function onImportFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    busy = true;
    try {
      const doc = JSON.parse(await file.text()) as ImportDoc;
      const pl = await api.importPlaylist(doc);
      await onRefresh();
      await openDetail(pl.id);
    } catch (err) {
      onToast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      busy = false;
      input.value = ""; // allow re-importing the same file
    }
  }

  async function exportPlaylist(p: Playlist) {
    try {
      const doc = await api.exportPlaylist(p.id);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${p.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.playlist.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      fail(e);
    }
  }

  function song(i: PlaylistItem): string {
    return i.title || i.filename || (i.md5 ? i.md5.slice(0, 12) : "unknown");
  }
  // Group · artist context prefix — mirrors the library row's sub-label so a mod
  // reads the same in every list view.
  function sub(i: PlaylistItem): string {
    return [i.group, i.artist].filter(Boolean).join(" · ");
  }
  function fmtTime(sec: number): string {
    if (!sec || !isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
</script>

<div class="tab">
  {#if !detail && !detailLoading}
    <!-- master: list of playlists -->
    <div class="newrow">
      <input
        placeholder="new playlist…"
        bind:value={newName}
        onkeydown={(e) => e.key === "Enter" && create()}
      />
      <button class="ok" onclick={create} disabled={busy || !newName.trim()}>
        <Plus size={14} /> add
      </button>
      <button
        class="ghost"
        onclick={() => importInput?.click()}
        disabled={busy}
        title="import a list"
      >
        <Upload size={14} /> import
      </button>
      <input
        bind:this={importInput}
        type="file"
        accept="application/json,.json"
        class="hidden-file"
        onchange={onImportFile}
      />
    </div>

    <ul class="plist">
      {#each playlists as p (p.id)}
        <li>
          <button class="open" onclick={() => openDetail(p.id)}>
            <span class="pn">{p.name}</span>
            <span class="pc">{p.item_count}</span>
          </button>
          <button class="mini" title="export" onclick={() => exportPlaylist(p)}>
            <Download size={13} />
          </button>
          <button class="mini" title="rename" onclick={() => rename(p)}>✎</button>
          <button class="mini" title="delete" onclick={() => remove(p.id)}>
            <Trash2 size={13} />
          </button>
        </li>
      {:else}
        <li class="empty">no playlists yet — create one above, or import a list</li>
      {/each}
    </ul>
  {:else}
    <!-- detail: a single playlist's tracks -->
    <div class="dactions">
      <button class="back" onclick={closeDetail}>‹ playlists</button>
      <span class="crumb">{detail?.playlist.name ?? "loading…"}</span>
      {#if detail && missingCount > 0 && !STANDALONE}
        <button
          class="ok"
          onclick={fetchMissing}
          disabled={fetching}
          title="download missing (Modland, else direct url)"
        >
          <Download size={14} />
          {fetching
            ? `fetching ${fetchp?.fetched ?? 0}/${fetchp?.total ?? missingCount}`
            : `fetch ${missingCount} missing`}
        </button>
      {/if}
      {#if detail}
        <button
          class="ok play"
          onclick={playDetail}
          disabled={!detail.items.some((i) => i.present)}
        >
          <Play size={14} /> play
        </button>
      {/if}
    </div>
    {#if !detail || detailLoading}
      <p class="msg">loading…</p>
    {:else}
      <ol class="items">
        {#each detail.items as it, i (it.id)}
          <li class:missing={!it.present} class:current={isCurrent(it)}>
            <span class="ix">{i + 1}</span>
            {#if it.present}
              <button
                class="it-name play-it"
                title="play — {it.path ?? ''}"
                onclick={() => playItem(it)}
              >
                {#if sub(it)}<span class="sub">{sub(it)}&nbsp;</span>{/if}<span class="song"
                  >{song(it)}</span
                >
              </button>
            {:else}
              <span class="it-name" title={it.md5 ?? ""}>
                {#if sub(it)}<span class="sub">{sub(it)}&nbsp;</span>{/if}<span class="song"
                  >{song(it)}</span
                ><span class="pending"> (missing)</span>
              </span>
            {/if}
            <span class="meta">
              {#if it.ext}<span class="fmt-chip">{it.ext}</span>{/if}
              <span class="dur">{it.duration ? fmtTime(it.duration) : ""}</span>
            </span>
            <button class="mini" title="up" disabled={i === 0} onclick={() => move(i, -1)}>
              <ChevronUp size={13} />
            </button>
            <button
              class="mini"
              title="down"
              disabled={i === detail.items.length - 1}
              onclick={() => move(i, 1)}
            >
              <ChevronDown size={13} />
            </button>
            <button class="mini" title="remove" onclick={() => removeItem(it.id)}>
              <X size={13} />
            </button>
          </li>
        {:else}
          <li class="empty">empty — add tracks from the library tab</li>
        {/each}
      </ol>
    {/if}
  {/if}
</div>

<style>
  .tab {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .newrow {
    display: flex;
    gap: 8px;
    padding: 0 0 12px;
    flex-wrap: wrap;
  }
  .newrow input {
    flex: 1;
    min-width: 160px;
    padding: 7px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
  }
  .hidden-file {
    display: none;
  }
  .ok,
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border-radius: 4px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .ok {
    border: 1px solid var(--accent);
    color: var(--accent);
    background: var(--panel-hi);
  }
  .ghost {
    border: 1px solid var(--border);
    color: var(--muted);
    background: var(--panel-hi);
  }
  .ok:disabled,
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .plist,
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .plist li {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 4px;
  }
  .plist li:hover {
    background: var(--panel-hi);
  }
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 10px 8px;
    cursor: pointer;
  }
  .pn {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pc {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .mini,
  .back {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    padding: 4px 6px;
  }
  .mini:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .dactions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 10px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .back {
    color: var(--text);
    flex: 0 0 auto;
  }
  .crumb {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .play {
    margin-left: auto;
  }
  .items li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 6px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .items li.missing {
    opacity: 0.5;
  }
  /* Currently-playing item: accent left-bar + tint, like the library row. */
  .items li.current {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    box-shadow: inset 2px 0 0 var(--accent);
    border-radius: 4px;
  }
  .items li.current .song {
    color: var(--accent);
    font-weight: 600;
  }
  .ix {
    flex: 0 0 auto;
    width: 26px;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .it-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Present rows are click-to-play buttons; strip the button chrome. */
  .play-it {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .pending {
    color: var(--muted);
    font-size: 12px;
  }
  /* Field styling mirrors the library row so a mod reads the same across views:
     a muted group·artist sub-label prefixing the song title. */
  .sub {
    color: var(--muted);
  }
  .song {
    color: var(--text);
  }
  /* Secondary metadata cluster (format + duration). On desktop it sits inline
     between the name and the reorder controls; on mobile it wraps to a second
     row (the reorder controls can't be hidden the way the library hides fav/
     rename, so the row goes two-line instead). */
  .meta {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .fmt-chip {
    flex: 0 0 auto;
    font-size: 10px;
    line-height: 1;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text);
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 5px;
  }
  .dur {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 640px) {
    .items li {
      flex-wrap: wrap;
    }
    /* Row 1: [#] name … ↑ ↓ ✕. Row 2: the metadata, indented under the name. */
    .it-name {
      order: 1;
    }
    .mini {
      order: 2;
    }
    .meta {
      order: 3;
      flex-basis: 100%;
      margin-left: 32px;
    }
  }
  .empty,
  .msg {
    color: var(--muted);
    padding: 16px 8px;
    list-style: none;
  }
</style>
