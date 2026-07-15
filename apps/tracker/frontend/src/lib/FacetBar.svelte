<script lang="ts">
  // Library facet/sort toolbar. Fully shared-state driven — no props: reads the
  // view store (group-by / sorts / facet filters) + the library store (tracks for
  // the facet options, scanning to disable). Grouping/filter logic itself lives in
  // $lib/library; this is just the controls.
  import { facetFormats, facetTrackers } from "$lib/library";
  import { library } from "$lib/library.svelte";
  import { bucketNoun, controlsActive, resetControls, view } from "$lib/view.svelte";

  const favView = $derived(view.tab === "favourites");
  const facetBase = $derived(favView ? library.tracks.filter((t) => t.favorite) : library.tracks);
  const formats = $derived(facetFormats(facetBase));
  const trackers = $derived(facetTrackers(facetBase));
</script>

<div class="controls" aria-label="library controls">
  <!-- Cluster 1 — how the list is organised: bucket dimension + bucket order. -->
  <div class="cgroup">
    <label class="groupby">
      group by
      <select bind:value={view.groupBy} disabled={library.scanning}>
        <option value="group">group</option>
        <option value="artist">artist</option>
        <option value="album">album</option>
        <option value="ext">format</option>
      </select>
    </label>
    <label class="groupby opt">
      {bucketNoun()}
      <select
        bind:value={view.groupSort}
        disabled={library.scanning}
        aria-label="order {bucketNoun()}"
      >
        <option value="name">A-Z</option>
        <option value="plays">play count</option>
        <option value="size">size</option>
      </select>
    </label>
  </div>
  <!-- Cluster 2 — how tracks are ordered within each bucket. -->
  <div class="cgroup">
    <label class="groupby">
      sort
      <select bind:value={view.trackSort} disabled={library.scanning}>
        <option value="name">name</option>
        <option value="duration">duration</option>
        <option value="channels">channels</option>
        <option value="plays">plays</option>
      </select>
    </label>
  </div>
  <!-- Cluster 3 — facet filters over the enrichment. -->
  <div class="cgroup">
    <label class="groupby">
      format
      <select bind:value={view.fmtFilter} disabled={library.scanning}>
        <option value="">all</option>
        {#each formats as f (f)}
          <option value={f}>{f}</option>
        {/each}
      </select>
    </label>
    <label class="groupby opt">
      tracker
      <select bind:value={view.trackerFilter} disabled={library.scanning}>
        <option value="">all</option>
        {#each trackers as tr (tr)}
          <option value={tr}>{tr}</option>
        {/each}
      </select>
    </label>
  </div>
  {#if controlsActive()}
    <button class="reset" onclick={resetControls} disabled={library.scanning}>reset</button>
  {/if}
</div>

<style>
  /* Button/select base is global (see +layout); only the toolbar layout here. */
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 18px;
    padding: 8px 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .cgroup {
    display: flex;
    align-items: center;
    gap: 6px 10px;
  }
  .groupby {
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .controls .reset {
    margin-left: auto;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 10px;
  }
  /* Phone: tighter, and hide the least-used facets (bucket order + tracker, marked
     .opt) so the row stays short. group-by, track sort + format stay. */
  @media (max-width: 640px) {
    .controls {
      gap: 8px 12px;
      padding: 8px 10px;
    }
    .controls .opt {
      display: none;
    }
    .groupby {
      font-size: 12px;
    }
  }
</style>
