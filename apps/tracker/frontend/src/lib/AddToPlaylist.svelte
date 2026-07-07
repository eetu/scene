<script lang="ts">
  // Add-to-playlist chooser. Owns its own add flow (the api calls + the new-name
  // field + busy state); the parent just supplies the track + playlists and
  // reacts to onAdded/onError (refresh + toast). Uses the shared Modal.
  import { api, type Playlist, type Track } from "$lib/api";
  import Modal from "$lib/Modal.svelte";

  let {
    track,
    playlists,
    onClose,
    onAdded,
    onError,
  }: {
    track: Track;
    playlists: Playlist[];
    onClose: () => void;
    onAdded: (playlistName: string) => void;
    onError: (message: string) => void;
  } = $props();

  let newName = $state("");
  let busy = $state(false);

  // Playlist items are keyed by md5; carry the track's metadata as the cache.
  function item() {
    return {
      md5: track.md5 ?? "",
      title: track.title,
      artist: track.artist,
      format: track.ext,
      filename: track.filename,
    };
  }

  async function add(id: string, name: string) {
    if (!track.md5) return;
    busy = true;
    try {
      await api.addToPlaylist(id, item());
      onAdded(name);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  async function addNew() {
    const name = newName.trim();
    if (!name || !track.md5) return;
    busy = true;
    try {
      const pl = await api.createPlaylist(name);
      await api.addToPlaylist(pl.id, item());
      onAdded(name);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }
</script>

<Modal label="add to playlist" {onClose}>
  <h3>add to playlist</h3>
  <p class="add-track">{track.title || track.filename}</p>
  <div class="add-list">
    {#each playlists as p (p.id)}
      <button class="add-row" onclick={() => add(p.id, p.name)} disabled={busy}>
        <span class="pn">{p.name}</span>
        <span class="pc">{p.item_count}</span>
      </button>
    {:else}
      <p class="empty">no playlists yet — make one below</p>
    {/each}
  </div>
  <div class="newrow">
    <input
      placeholder="new playlist…"
      bind:value={newName}
      onkeydown={(e) => e.key === "Enter" && addNew()}
    />
    <button class="ok" onclick={addNew} disabled={busy || !newName.trim()}>create &amp; add</button>
  </div>
  <div class="modal-actions">
    <button onclick={onClose} disabled={busy}>cancel</button>
  </div>
</Modal>

<style>
  .add-track {
    margin: 0;
    color: var(--accent);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 240px;
    overflow-y: auto;
  }
  .add-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .add-row .pn {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-row .pc {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .newrow {
    display: flex;
    gap: 8px;
  }
  .newrow input {
    flex: 1;
    min-width: 0;
  }
  .empty {
    color: var(--muted);
    padding: 24px 0;
  }
</style>
