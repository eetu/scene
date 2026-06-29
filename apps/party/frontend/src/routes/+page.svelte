<script lang="ts">
  // Landing: the list of scanned parties. Each card links to that party's
  // catalog. Polls /status while an initial scan is running.
  import { CalendarDays, MapPin, Music, RefreshCw } from "@lucide/svelte";
  import { stop as stopPlayback } from "@scene/player";
  import { onMount } from "svelte";

  import { api, fileUrl, type Party, type StatusResponse } from "$lib/api";
  import { listKeys } from "$lib/listkeys";
  import Settings from "$lib/Settings.svelte";

  let parties = $state<Party[]>([]);
  let status = $state<StatusResponse | null>(null);
  let error = $state<string | null>(null);
  let rescanning = $state(false);

  const NATIVE_IMG = new Set(["gif", "jpg", "jpeg", "png"]);

  async function load() {
    status = await api.status();
    if (status.scanning) {
      setTimeout(load, 1000);
      return;
    }
    parties = await api.parties();
  }

  // Re-walk the whole Parties/ tree, then refresh the list. The request blocks
  // until the scan finishes (fast on a warm cache — unchanged files aren't
  // re-hashed); the button shows progress meanwhile.
  async function rescan() {
    if (rescanning) return;
    rescanning = true;
    error = null;
    try {
      await api.rescan();
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      rescanning = false;
    }
  }

  onMount(() => {
    // The landing has no transport bar, so stop any playback on arrival —
    // otherwise music keeps playing with no visible controls (e.g. after
    // clicking the party name to go home).
    stopPlayback();
    load().catch((e) => (error = String(e)));
  });
</script>

<header>
  <h1>party</h1>
  <span class="sub">demoparty archive player</span>
  <!-- Stable spacer so the right group (Rescan?, gear) stays right-aligned even
       when the button is absent (kiosk) or the tagline is hidden (mobile). -->
  <span class="spacer"></span>
  <!-- Operator-only: hidden on a public (kiosk) instance, where the backend also
       refuses POST /api/rescan. Shown once status loads on a non-kiosk instance. -->
  {#if status && !status.kiosk}
    <button class="action" onclick={rescan} disabled={rescanning} title="Rescan the archive">
      <RefreshCw size={15} class={rescanning ? "spin" : ""} />
      {rescanning ? "Rescanning…" : "Rescan"}
    </button>
  {/if}
  <Settings />
</header>

<main>
  {#if error}
    <p class="error">{error}</p>
  {:else if status?.scanning}
    <p class="muted">
      scanning… {status.scan_processed} files{status.scan_total ? ` / ${status.scan_total}` : ""} ({status.scan_hashed}
      hashed)
    </p>
  {:else if parties.length === 0}
    <p class="muted">no parties found under the archive root.</p>
  {:else}
    <div class="grid" use:listKeys>
      {#each parties as p (p.slug)}
        <a class="card" href={`/${p.slug}`}>
          <div class="thumb">
            {#if p.logo_hash && p.logo_kind && NATIVE_IMG.has(p.logo_kind === "image" ? "gif" : p.logo_kind)}
              <img src={fileUrl(p.logo_hash)} alt="" />
            {:else}
              <span class="glyph">{(p.name[0] ?? "?").toUpperCase()}</span>
            {/if}
          </div>
          <div class="meta">
            <h2>{p.name}</h2>
            <div class="facts">
              {#if p.year}<span><CalendarDays size={13} /> {p.year}</span>{/if}
              {#if p.location}<span><MapPin size={13} /> {p.location}</span>{/if}
            </div>
            <div class="counts">
              <span><Music size={13} /> {p.n_productions} productions</span>
              <span>{p.n_files} files</span>
            </div>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</main>

<!-- Archive disclaimer — shown to everyone, kiosk included. Productions belong to
     their authors; this is a non-commercial preservation mirror, with a removal
     path via the repo's issues. -->
<footer class="legal">
  A non-commercial archive for demoscene preservation. Productions are © their respective authors
  &amp; groups, mirrored from
  <a href="https://scene.org" target="_blank" rel="noreferrer">scene.org</a>. Not affiliated with
  scene.org or the parties' organizers. Source &amp; removal requests:
  <a href="https://github.com/eetu/scene/issues" target="_blank" rel="noreferrer"
    >github.com/eetu/scene/issues</a
  >.
</footer>

<style>
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    /* Clear the iOS status bar (translucent, full-bleed under viewport-fit=cover)
       + the landscape notch. env() is 0 where there's no inset. */
    padding: calc(16px + env(safe-area-inset-top)) calc(20px + env(safe-area-inset-right)) 16px
      calc(20px + env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
  }
  h1 {
    margin: 0;
    font-family: var(--font-retro);
    font-size: 22px;
    color: var(--accent);
  }
  .sub {
    color: var(--muted);
    font-size: 13px;
  }
  .spacer {
    flex: 1;
  }
  .action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
    border-radius: 6px;
    padding: 0 12px;
    height: 32px;
    font-size: 13px;
    cursor: pointer;
  }
  .action:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .action:disabled {
    opacity: 0.7;
    cursor: default;
  }
  .action :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  main {
    flex: 1;
    min-height: 0;
    padding: 20px;
    overflow: auto;
  }
  .legal {
    flex: 0 0 auto;
    padding: 10px 20px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }
  .legal a {
    color: var(--muted);
    text-decoration: underline;
  }
  .legal a:hover {
    color: var(--accent);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
  }
  .card {
    display: flex;
    gap: 14px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    text-decoration: none;
    color: var(--text);
    transition: border-color 0.15s;
  }
  .card:hover {
    border-color: var(--accent);
  }
  .thumb {
    flex: 0 0 64px;
    width: 64px;
    height: 64px;
    display: grid;
    place-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    image-rendering: pixelated;
  }
  .glyph {
    font-family: var(--font-retro);
    font-size: 32px;
    color: var(--accent);
  }
  .meta h2 {
    margin: 0 0 4px;
    font-size: 16px;
  }
  .facts,
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    color: var(--muted);
    font-size: 12px;
    margin-top: 4px;
  }
  .facts span,
  .counts span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .error {
    color: #ff4136;
  }
  .muted {
    color: var(--muted);
  }
  @media (max-width: 480px) {
    /* Tight phone header: drop the tagline so brand + Rescan + gear fit a row. */
    .sub {
      display: none;
    }
    main {
      padding: 14px 12px;
    }
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
