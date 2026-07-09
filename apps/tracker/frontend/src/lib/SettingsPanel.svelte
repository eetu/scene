<script lang="ts">
  // Settings overlay. Everything it shows is shared rune state read directly — no
  // props beyond onClose: theme (@scene/design), patternMode ($lib/settings), and
  // the library scan/enrich state + actions ($lib/library.svelte).
  import { Copy, Monitor, Moon, RefreshCw, ScanLine, Sun } from "@lucide/svelte";
  import { setAccent, setTheme, theme } from "@scene/design";

  import {
    cancelEnrich,
    enrichLibrary,
    library,
    rescanLibrary,
    unEnriched,
  } from "$lib/library.svelte";
  import Modal from "$lib/Modal.svelte";
  import { setPatternMode, settings } from "$lib/settings.svelte";

  let { onClose, onDupes }: { onClose: () => void; onDupes: () => void } = $props();
</script>

<Modal label="settings" {onClose}>
  <h3>settings</h3>
  <div class="setting">
    <span class="setting-label">theme</span>
    <div class="seg">
      <button class:on={theme.mode === "light"} onclick={() => setTheme("light")}>
        <Sun size={15} /> light
      </button>
      <button class:on={theme.mode === "dark"} onclick={() => setTheme("dark")}>
        <Moon size={15} /> dark
      </button>
      <button class:on={theme.mode === "auto"} onclick={() => setTheme("auto")}>
        <Monitor size={15} /> auto
      </button>
    </div>
  </div>
  <div class="setting">
    <span class="setting-label">accent</span>
    <div class="seg">
      <button class:on={theme.accent === "orange"} onclick={() => setAccent("orange")}>
        <span class="swatch" style="background:#f78f08"></span> orange
      </button>
      <button class:on={theme.accent === "purple"} onclick={() => setAccent("purple")}>
        <span class="swatch" style="background:#a370f0"></span> purple
      </button>
    </div>
  </div>
  <div class="setting">
    <span class="setting-label">pattern view</span>
    <div class="seg">
      <button class:on={settings.patternMode === "locked"} onclick={() => setPatternMode("locked")}>
        <ScanLine size={15} /> centerline
      </button>
      <button class:on={settings.patternMode === "scroll"} onclick={() => setPatternMode("scroll")}>
        free scroll
      </button>
    </div>
  </div>
  <div class="setting">
    <span class="setting-label">library</span>
    <div class="seg">
      <button onclick={rescanLibrary} disabled={library.scanning}>
        <RefreshCw size={15} />
        {library.scanning ? "scanning…" : "rescan"}
      </button>
      {#if library.enriching}
        <button onclick={cancelEnrich}>cancel {library.enrichDone}/{library.enrichTotal}</button>
      {:else}
        <button onclick={enrichLibrary} disabled={library.scanning || unEnriched() === 0}>
          {unEnriched() > 0 ? `enrich ${unEnriched()}` : "all enriched"}
        </button>
      {/if}
    </div>
    <span class="setting-hint">
      {#if library.scanning}
        scanning… {(
          library.status?.scan_processed ?? 0
        ).toLocaleString()}{#if (library.status?.scan_total ?? 0) > 0}/{(
            library.status?.scan_total ?? 0
          ).toLocaleString()}{/if}
      {:else}
        {library.tracks.length.toLocaleString()} modules{#if unEnriched() > 0}
          · {unEnriched().toLocaleString()} need metadata{/if}
      {/if}
    </span>
  </div>
  <div class="setting">
    <span class="setting-label">cleanup</span>
    <div class="seg">
      <button onclick={onDupes} disabled={library.scanning}>
        <Copy size={15} /> find duplicates
      </button>
    </div>
    <span class="setting-hint">Review identical / same-named modules and delete extras.</span>
  </div>
  <div class="modal-actions">
    <button onclick={onClose}>close</button>
  </div>
</Modal>

<style>
  .setting {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .setting-label {
    font-size: 12px;
    color: var(--muted);
  }
  /* Status line under a setting's controls (library counts / scan state). */
  .setting-hint {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .seg {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .seg button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 10px;
    white-space: nowrap;
  }
  .seg button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .swatch {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  }
</style>
