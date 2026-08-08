<script lang="ts">
  import {
    ChevronDown,
    ChevronUp,
    Download,
    Pencil,
    Play,
    Plus,
    Trash2,
    Upload,
    X,
  } from "@lucide/svelte";
  import { fmtTime, playback } from "@scene/player";

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

  // Import / export: JSON documents — see api.ImportDoc.
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
  // Group · artist context, trailing the title — mirrors the library row's
  // sub-label so a mod reads the same in every list view.
  function sub(i: PlaylistItem): string {
    return [i.group, i.artist].filter(Boolean).join(" · ");
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
          <button class="mini" title="rename" onclick={() => rename(p)}>
            <Pencil size={13} />
          </button>
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
            <!-- Title leads, muted group·artist trails — the library row's
                 hierarchy (and the transport's), so a mod reads the same in
                 every list. Present items are the click-to-play target. -->
            {#if it.present}
              <button
                class="it-name play-it"
                title="play — {it.path ?? ''}"
                onclick={() => playItem(it)}
              >
                <span class="nm"
                  ><span class="song">{song(it)}</span>{#if sub(it)}<span class="sub"
                      >&nbsp;{sub(it)}</span
                    >{/if}</span
                >
              </button>
            {:else}
              <span class="it-name" title={it.md5 ?? ""}>
                <span class="nm"
                  ><span class="song">{song(it)}</span>{#if sub(it)}<span class="sub"
                      >&nbsp;{sub(it)}</span
                    >{/if}<span class="pending">&nbsp;(missing)</span></span
                >
              </span>
            {/if}
            <span class="dur">{it.duration ? fmtTime(it.duration) : ""}</span>
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
  /* Row hover highlight — never on the "nothing here yet" placeholder li, which
     isn't a target. */
  .plist li:not(.empty):hover,
  .items li:not(.empty):hover:not(.current) {
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
  /* One line at every width, like a library row: [#] title+muted sub … duration,
     then the row's actions. The height comes from the row (not per-child padding)
     so a long list reads as an even column. */
  .items li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 0 6px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
    border-radius: 4px;
  }
  .items li.missing {
    opacity: 0.5;
  }
  /* Currently-playing item: accent left-bar + tint, like the library row. */
  .items li.current {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    box-shadow: inset 2px 0 0 var(--accent);
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
  /* The name cell fills the row's height (so the whole line is one comfortable
     target) and .nm carries the ellipsis — text-overflow needs an inline-content
     box, which a flex container isn't. Same split as the library row's .row/.name. */
  .it-name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    align-self: stretch;
  }
  .nm {
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
  /* Duration is the only metadata left in the row — the format chip is gone for
     the same reason the library row dropped it: it was the loudest field despite
     being the least decision-relevant, and it's what forced a second line on a
     phone. Fixed-width + right-aligned so the column doesn't go ragged. */
  .dur {
    flex: 0 0 auto;
    width: 40px;
    text-align: right;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 640px) {
    /* Still ONE line (the library's mobile row): with the chip gone, the name
       ellipsises instead of wrapping the metadata to a padded second row. Rows
       grow a touch and the row buttons get touch-sized padding — reorder/remove
       have no other home, so unlike fav/rename they can't be hidden here. */
    .items li {
      min-height: 40px;
      gap: 4px;
    }
    /* Narrower position column buys the title back the width the touch-sized
       buttons take (2 digits still fit; 3 just push into the gap). */
    .ix {
      width: 16px;
    }
    li .mini {
      padding: 9px 5px;
    }
  }
  .empty,
  .msg {
    color: var(--muted);
    padding: 16px 8px;
    list-style: none;
  }
</style>
