<script lang="ts">
  // Landing: the list of scanned parties. Each card links to that party's
  // catalog. Polls /status while an initial scan is running.
  import { CalendarDays, MapPin, Music } from "@lucide/svelte";
  import { stop as stopPlayback } from "@scene/player";
  import { onMount } from "svelte";

  import { api, assetUrl, fileUrl, type Party, type StatusResponse } from "$lib/api";
  import { listKeys } from "$lib/listkeys";
  import Settings from "$lib/Settings.svelte";

  let parties = $state<Party[]>([]);
  let status = $state<StatusResponse | null>(null);
  let error = $state<string | null>(null);
  // Scan-stall detection: if scan_processed stops advancing while still
  // "scanning", surface a hint + reload instead of an eternal silent spinner.
  let scanStalled = $state(false);
  let lastProcessed = -1;
  let stalledPolls = 0;

  // Browser-native image MIMEs are served raw; anything else (e.g. a scene-native
  // ILBM logo) goes through the transcoder → PNG. Mirrors FileBrowser's decision.
  const NATIVE_IMG = new Set(["image/gif", "image/jpeg", "image/png", "image/bmp"]);

  // Thumbnail fallback glyph: each word's first letter (skipping words that
  // start with a digit or symbol) + a scene-style 'YY year, so the same party
  // across years stays distinct ("The Gathering 1996" → "TG'96").
  function glyph(p: Party): string {
    const ini =
      p.name
        .split(/\s+/)
        .map((w) => w[0])
        .filter((c) => c && /[a-z]/i.test(c))
        .join("")
        .toUpperCase() || "?";
    if (p.year == null) return ini;
    const yy = String(((p.year % 100) + 100) % 100).padStart(2, "0");
    return `${ini}'${yy}`;
  }

  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  // Poll /status until the initial/rescan scan finishes, then load the parties.
  // Resilient by design: a transient error mid-scan (the DB is briefly locked by
  // the scan, or a slow-NAS hiccup) reschedules the poll instead of killing the
  // chain — otherwise the page freezes on "scanning…" forever and never recovers
  // even after the scan completes. Clears the error once a request succeeds.
  async function load() {
    try {
      status = await api.status();
      if (status.scanning) {
        const p = status.scan_processed ?? 0;
        if (p === lastProcessed) stalledPolls++;
        else {
          stalledPolls = 0;
          lastProcessed = p;
        }
        scanStalled = stalledPolls >= 20; // ~20s with no newly-processed files
        pollTimer = setTimeout(load, 1000);
        return;
      }
      stalledPolls = 0;
      lastProcessed = -1;
      scanStalled = false;
      parties = await api.parties();
      error = null;
    } catch (e) {
      error = String(e);
      pollTimer = setTimeout(load, 1500); // keep polling through transient errors
    }
  }

  onMount(() => {
    // The landing has no transport bar, so stop any playback on arrival —
    // otherwise music keeps playing with no visible controls (e.g. after
    // clicking the party name to go home).
    stopPlayback();
    void load();
    return () => {
      if (pollTimer) clearTimeout(pollTimer);
    };
  });
</script>

<header>
  <h1>party</h1>
  <span class="sub">demoparty archive player</span>
  <!-- Stable spacer so the right group (Rescan?, gear) stays right-aligned even
       when the button is absent (kiosk) or the tagline is hidden (mobile). -->
  <span class="spacer"></span>
  <!-- Rescan now lives in the Settings modal (available inside a party view too);
       reload the list when a scan finishes. -->
  <Settings onRescanned={load} />
</header>

<main>
  {#if error}
    <p class="error">{error}</p>
  {:else if status?.scanning}
    <p class="muted">
      scanning… {status.scan_processed} files{status.scan_total ? ` / ${status.scan_total}` : ""} ({status.scan_hashed}
      hashed)
    </p>
    {#if scanStalled}
      <p class="muted">
        No new files for a while — the scan may be stuck on a large file, or it finished without
        notifying. <button class="link" onclick={() => location.reload()}>Reload</button> to re-check.
      </p>
    {/if}
  {:else if parties.length === 0}
    <p class="muted">no parties found under the archive root.</p>
  {:else}
    <div class="grid" use:listKeys>
      {#each parties as p (p.slug)}
        <a class="card" href={`/${p.slug}`}>
          <div class="thumb">
            {#if p.logo_hash && p.logo_mime?.startsWith("image/")}
              <img
                src={NATIVE_IMG.has(p.logo_mime)
                  ? fileUrl(p.logo_hash)
                  : assetUrl(p.logo_hash, "png")}
                alt=""
              />
            {:else}
              <span class="glyph">{glyph(p)}</span>
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
    font-size: 19px;
    line-height: 1;
    letter-spacing: 0.5px;
    color: var(--accent);
    white-space: nowrap;
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
  .link {
    padding: 0 2px;
    background: none;
    border: none;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
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
