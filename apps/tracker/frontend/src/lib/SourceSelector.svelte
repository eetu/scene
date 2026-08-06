<script lang="ts">
  // The source scope: which configured collection the library is showing.
  //
  // Deliberately NOT a peer of the library / favourites / playlists tabs —
  // those are cross-cutting *over* sources (a favourited HVSC tune still
  // belongs under Favourites), so making this a fourth tab would conflate two
  // axes. It's the sticky collection filter, promoted from a dropdown item to a
  // first-class control, because with two collections in one library the scope
  // decides what shuffle can reach.
  //
  // Hidden entirely when only one root is configured — a "Mods / All" pair with
  // nothing else in the library is noise. It appears when HVSC is mounted.
  import { type HvscState } from "$lib/api";
  import { library, reindexRoot } from "$lib/library.svelte";
  import { setCollection, view } from "$lib/view.svelte";

  let { onToast }: { onToast?: (msg: string, kind?: "ok" | "err") => void } = $props();

  const roots = $derived(library.status?.roots ?? []);
  const show = $derived(roots.length > 1);

  // Per-root HVSC facts. An absent entry means "not an HVSC root"; a present but
  // null entry means "configured, not indexed yet" — the state a collection sits
  // in while it's still being copied, which is worth saying out loud.
  const hvsc = $derived(library.status?.hvsc ?? {});
  const active = $derived(roots.find((r) => r.id === view.collection));
  const activeHvsc = $derived(active?.kind === "hvsc" ? active : null);

  let busy = $state(false);

  const fmt = (n: number | null) => (n === null ? "" : n.toLocaleString());

  /** The chip label: `HVSC #85` once the release is known. Falls back to the
   *  plain label rather than inventing a version — an unindexed or unreadable
   *  collection shouldn't render as `#null`. */
  function label(id: string, fallback: string): string {
    const v = (hvsc as Record<string, HvscState>)[id];
    return v?.version ? `${fallback} #${v.version}` : fallback;
  }

  /** Hover detail for an HVSC chip: what was indexed, and when. */
  function detail(id: string, path: string): string {
    if (!(id in hvsc)) return path;
    const v = (hvsc as Record<string, HvscState>)[id];
    if (!v) return `${path}\nnot indexed yet`;
    const when = new Date(v.indexed_at);
    const stamp = isNaN(when.getTime()) ? v.indexed_at : when.toLocaleString();
    return `${path}\n${fmt(v.tunes)} tunes, ${fmt(v.subtunes)} subtunes\nindexed ${stamp}`;
  }

  async function reindex(id: string) {
    if (busy) return;
    busy = true;
    try {
      // An HVSC reindex is one catalogue read, so it answers synchronously with
      // its counts — unlike a walked root, which answers 202 and reports via
      // /status.
      const r = await reindexRoot(id);
      onToast?.(`Indexed ${fmt(r.indexed ?? 0)} tunes, ${fmt(r.subtunes ?? 0)} subtunes`);
    } catch (e) {
      // A root pointed at a non-HVSC path answers 400 with why. Surfacing it
      // beats a button that appears to do nothing.
      onToast?.(e instanceof Error ? e.message : String(e), "err");
    } finally {
      busy = false;
    }
  }
</script>

{#if show}
  <nav class="sources" aria-label="collection">
    {#each roots as r (r.id)}
      <button
        class:on={view.collection === r.id}
        onclick={() => setCollection(r.id)}
        aria-pressed={view.collection === r.id}
        title={detail(r.id, r.path)}
      >
        {label(r.id, r.label)}
        {#if r.count !== null}<span class="cnt">{fmt(r.count)}</span>{/if}
      </button>
    {/each}
    <!-- Explicitly opting into a mixed queue: modules and SIDs are a different
         listening register, so mixing is a choice, never the default. -->
    <button
      class:on={view.collection === ""}
      onclick={() => setCollection("")}
      aria-pressed={view.collection === ""}
      title="every collection at once"
    >
      All
    </button>

    <!-- Reindex, only while an HVSC source is the one on screen. Safe as a
         button in a way a filesystem rescan isn't at this scale: it re-reads the
         collection's own catalogue (one 5MB file) rather than walking 61k
         tunes, so it costs seconds and touches nothing on disk. -->
    {#if activeHvsc}
      <button
        class="reindex"
        onclick={() => reindex(activeHvsc.id)}
        disabled={busy}
        title="Rebuild the index from this collection's own catalogue"
      >
        {busy ? "Indexing…" : "Reindex"}
      </button>
    {/if}
  </nav>
{/if}

<style>
  /* Sits between the view tabs and the facet bar: a quieter row than the tabs
     (it scopes what they show, rather than switching between them). */
  .sources {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .sources button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    font-size: 12px;
    background: transparent;
    color: var(--muted);
    border: 1px solid transparent;
  }
  .sources button:hover {
    color: var(--surface-fg);
  }
  .sources button.on {
    color: var(--surface-fg);
    background: var(--panel-hi);
    border-color: var(--border);
  }
  .cnt {
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .sources button.on .cnt {
    color: var(--accent);
  }
  /* Pushed to the far end: it acts on the current source rather than selecting
     one, so it shouldn't read as another chip in the same row of choices. */
  .reindex {
    margin-left: auto;
  }
  .reindex:disabled {
    opacity: 0.5;
    cursor: default;
  }

  @media (max-width: 640px) {
    .sources {
      padding: 4px 10px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .sources button {
      flex: 0 0 auto;
    }
  }
</style>
