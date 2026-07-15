<script lang="ts">
  // The curation editor for one track: rename/move it, and edit the manifest
  // graph around it — the artist's aliases + group memberships, the tune's
  // credits (for-group / co-authors / year), and its album membership. Rename
  // hits /api/rename (moves the file); the rest write library.json via the
  // curation API, then the manifest store re-fetches so the library re-groups.
  import { api, type Track } from "$lib/api";
  import { library } from "$lib/library.svelte";
  import { manifestIndex, manifestStore, reloadManifest } from "$lib/manifest.svelte";
  import Modal from "$lib/Modal.svelte";

  let {
    track,
    onClose,
    onSaved,
    onToast,
  }: {
    track: Track;
    onClose: () => void;
    onSaved: (patch: Partial<Track>) => void;
    onToast: (msg: string, kind?: "ok" | "err") => void;
  } = $props();

  const artistLayout = $derived((library.status?.layout ?? "group-artist") === "artist");
  const idx = $derived(manifestIndex());
  // The artist whose graph this edits — the track's canonical handle.
  const canonical = $derived(track.artist ? idx.canonical(track.artist) : "");

  const splitLines = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  const splitCommas = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  // ---- move (rename) ---- (all fields seeded by the $effect below, which also
  // re-seeds if the modal is reused for a different track)
  let dGroup = $state("");
  let dFolder = $state("");
  let dFilename = $state("");

  // ---- artist graph (seeded from the manifest for the canonical artist) ----
  const artistEntry = $derived(canonical ? manifestStore.data?.artists?.[canonical] : undefined);
  let dAka = $state("");
  let dGroups = $state("");
  // ---- credits (by md5) ----
  const credit = $derived(idx.credit(track.md5));
  let dForGroup = $state("");
  let dWith = $state("");
  let dYear = $state("");
  // ---- album membership ----
  const allAlbums = $derived(idx.albums());
  const memberIds = $derived(new Set(idx.albumsOf(track.md5).map((a) => a.id)));
  let inAlbums = $state<Record<string, boolean>>({});
  let newAlbum = $state("");

  // Seed the editable fields once, when the manifest snapshot for this track is
  // known. `untrack`-free: it only re-seeds if the identity inputs change.
  let seededFor = "";
  $effect(() => {
    const key = `${track.path}|${canonical}|${track.md5 ?? ""}`;
    if (key === seededFor) return;
    seededFor = key;
    dGroup = track.group;
    dFolder = track.artist ?? "";
    dFilename = track.filename;
    dAka = (artistEntry?.aka ?? []).join("\n");
    dGroups = (artistEntry?.groups ?? []).join(", ");
    dForGroup = credit?.forGroup ?? "";
    dWith = (credit?.with ?? []).join(", ");
    dYear = credit?.year != null ? String(credit.year) : "";
    inAlbums = Object.fromEntries(allAlbums.map((a) => [a.id, memberIds.has(a.id)]));
  });

  let saving = $state(false);
  let err = $state<string | null>(null);

  async function save() {
    saving = true;
    err = null;
    const patch: Partial<Track> = {};
    try {
      // 1) Rename / move (only if a path segment actually changed).
      const folderChanged = artistLayout
        ? dFolder.trim() !== (track.artist ?? "")
        : dGroup.trim() !== track.group || dFolder.trim() !== (track.artist ?? "");
      if (folderChanged || dFilename.trim() !== track.filename) {
        const res = await api.rename({
          from: track.path,
          group: artistLayout ? "" : dGroup,
          artist: dFolder.trim() || null,
          filename: dFilename.trim(),
        });
        Object.assign(patch, {
          path: res.path,
          group: res.group,
          artist: res.artist,
          filename: res.filename,
          ext: res.ext,
        });
      }

      // 2) Artist graph (aka + groups) for the canonical artist.
      if (canonical) {
        const aka = splitLines(dAka);
        const groups = splitCommas(dGroups);
        const prevAka = artistEntry?.aka ?? [];
        const prevGroups = artistEntry?.groups ?? [];
        if (aka.join("\n") !== prevAka.join("\n") || groups.join(",") !== prevGroups.join(",")) {
          await api.setArtist(canonical, { aka, groups });
        }
      }

      // 3) Credits (by md5).
      if (track.md5) {
        const w = splitCommas(dWith);
        const year = dYear.trim() ? Number(dYear.trim()) : null;
        const changed =
          (dForGroup.trim() || null) !== (credit?.forGroup ?? null) ||
          w.join(",") !== (credit?.with ?? []).join(",") ||
          year !== (credit?.year ?? null);
        if (changed) {
          await api.setSong(track.md5, {
            forGroup: dForGroup.trim() || null,
            with: w,
            year: Number.isFinite(year as number) ? year : null,
          });
        }
      }

      // 4) Album membership (add/remove diffs) + optional new album.
      if (track.md5) {
        for (const a of allAlbums) {
          const now = !!inAlbums[a.id];
          const was = memberIds.has(a.id);
          if (now && !was) await api.addAlbumSong(a.id, track.md5);
          else if (!now && was) await api.removeAlbumSong(a.id, track.md5);
        }
        if (newAlbum.trim()) {
          const { id } = await api.createAlbum({ title: newAlbum.trim() });
          if (id) await api.addAlbumSong(id, track.md5);
        }
      }

      await reloadManifest();
      onSaved(patch);
      onToast(`saved ${dFilename.trim() || track.filename}`);
      onClose();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<Modal label="curate" {onClose}>
  <h3>curate <span class="fmt">{track.ext}</span></h3>

  <section>
    <div class="sec">move</div>
    {#if !artistLayout}
      <label>group <input bind:value={dGroup} placeholder="group (blank = groupless)" /></label>
    {/if}
    <label>
      {artistLayout ? "artist (folder)" : "artist"}
      <input bind:value={dFolder} placeholder="artist" />
    </label>
    <label>filename <input bind:value={dFilename} placeholder="filename" /></label>
  </section>

  {#if canonical}
    <section>
      <div class="sec">artist · <b>{canonical}</b></div>
      <label>
        also known as <span class="hint">(one handle per line)</span>
        <textarea bind:value={dAka} rows="2" placeholder="other handles"></textarea>
      </label>
      <label>
        groups <span class="hint">(comma-separated)</span>
        <input bind:value={dGroups} placeholder="e.g. Future Crew, Anarchy" />
      </label>
    </section>
  {/if}

  {#if track.md5}
    <section>
      <div class="sec">credits</div>
      <label>for group <input bind:value={dForGroup} placeholder="released for (optional)" /></label
      >
      <div class="two">
        <label>with <input bind:value={dWith} placeholder="co-authors, comma-sep" /></label>
        <label>year <input bind:value={dYear} placeholder="1993" inputmode="numeric" /></label>
      </div>
    </section>

    <section>
      <div class="sec">albums</div>
      {#if allAlbums.length}
        <div class="chips">
          {#each allAlbums as a (a.id)}
            <label class="chip" class:on={inAlbums[a.id]}>
              <input type="checkbox" bind:checked={inAlbums[a.id]} />
              {a.label}
            </label>
          {/each}
        </div>
      {/if}
      <label>new album <input bind:value={newAlbum} placeholder="create + add this tune" /></label>
    </section>
  {/if}

  {#if err}<p class="err">{err}</p>{/if}
  <div class="modal-actions">
    <button onclick={onClose} disabled={saving}>cancel</button>
    <button class="ok" onclick={save} disabled={saving}>save</button>
  </div>
</Modal>

<style>
  h3 {
    margin: 0 0 8px;
  }
  .fmt {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
  }
  section {
    border-top: 1px solid var(--border);
    padding: 8px 0;
  }
  .sec {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .sec b {
    color: var(--text);
    text-transform: none;
    letter-spacing: 0;
  }
  label {
    display: block;
    font-size: 12px;
    color: var(--muted);
    margin: 6px 0 0;
  }
  input,
  textarea {
    display: block;
    width: 100%;
    margin-top: 2px;
    font: inherit;
    box-sizing: border-box;
  }
  .hint {
    color: var(--muted);
    opacity: 0.7;
  }
  .two {
    display: flex;
    gap: 8px;
  }
  .two label {
    flex: 1;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 2px 0 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    padding: 2px 8px;
    font-size: 12px;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
  }
  .chip.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .chip input {
    width: auto;
    margin: 0;
  }
  .err {
    color: var(--halo-error);
    font-size: 12px;
    margin: 6px 0 0;
  }
</style>
