<script lang="ts">
  // Header settings: a gear button (always visible) opening a modal with the
  // theme selector + operator actions (library rescan) — mirrors tracker's
  // settings. Self-contained; drop <Settings/> into any header. Because rescan
  // lives here (not just the landing header), it can be triggered from inside a
  // party view too. `onRescanned` lets the host refresh its list when a scan
  // finishes (the landing passes its loader; the party view can omit it).
  import { Monitor, Moon, RefreshCw, Settings as Gear, Sun } from "@lucide/svelte";
  import { setTheme, theme, trapFocus } from "@scene/design";

  import { api, type StatusResponse } from "$lib/api";

  let { onRescanned }: { onRescanned?: () => void } = $props();

  let open = $state(false);
  let status = $state<StatusResponse | null>(null);
  let rescanning = $state(false);

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") open = false;
  }

  // Load status when the modal first opens (to know kiosk + file count) — cheap,
  // and avoids polling in the background.
  $effect(() => {
    if (open && !status) void refreshStatus();
  });
  async function refreshStatus() {
    try {
      status = await api.status();
    } catch {
      /* non-fatal — the rescan row just stays hidden until status loads */
    }
  }

  // Re-walk the whole Parties/ tree, then refresh. The request blocks until the
  // scan finishes (fast on a warm cache); poll /status meanwhile so the file
  // count ticks up. On completion, let the host refresh its list.
  async function rescan() {
    if (rescanning) return;
    rescanning = true;
    let done = false;
    const poller = (async () => {
      while (!done) {
        await refreshStatus();
        await new Promise((r) => setTimeout(r, 700));
      }
    })();
    try {
      await api.rescan();
    } catch {
      /* surfaced via the count not advancing; keep the UI responsive */
    } finally {
      done = true;
      await poller;
      await refreshStatus();
      rescanning = false;
      onRescanned?.();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<button class="gear" onclick={() => (open = true)} title="Settings" aria-label="Settings">
  <Gear size={18} />
</button>

{#if open}
  <div class="modal-bg">
    <button class="modal-scrim" aria-label="close" onclick={() => (open = false)}></button>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="settings"
      tabindex="-1"
      use:trapFocus
    >
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
      <!-- Operator-only: hidden on a public (kiosk) instance, where the backend
           also refuses POST /api/rescan. -->
      {#if status && !status.kiosk}
        <div class="setting">
          <span class="setting-label">library</span>
          <button class="rescan" onclick={rescan} disabled={rescanning} title="Rescan the archive">
            <RefreshCw size={15} class={rescanning ? "spin" : ""} />
            {#if rescanning}
              Rescanning… {status.scan_processed ?? 0}{status.scan_total
                ? ` / ${status.scan_total}`
                : ""}
            {:else}
              Rescan archive{status.file_count != null ? ` (${status.file_count} files)` : ""}
            {/if}
          </button>
        </div>
      {/if}
      <div class="modal-actions">
        <button class="close" onclick={() => (open = false)}>close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .gear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  .gear:hover {
    border-color: var(--accent);
  }
  .modal-bg {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .modal-scrim {
    position: absolute;
    inset: 0;
    border: none;
    background: rgba(0, 0, 0, 0.5);
    cursor: pointer;
  }
  .modal {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 420px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .modal h3 {
    margin: 0;
    font-size: 14px;
  }
  .setting {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .setting-label {
    font-size: 12px;
    color: var(--muted);
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
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-hi);
    color: var(--text);
    cursor: pointer;
  }
  .seg button:hover {
    border-color: var(--accent);
  }
  .seg button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .rescan {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-hi);
    color: var(--text);
    cursor: pointer;
  }
  .rescan:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .rescan:disabled {
    opacity: 0.7;
    cursor: default;
  }
  .rescan :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }
  .modal-actions .close {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-hi);
    color: var(--text);
    cursor: pointer;
  }
  .modal-actions .close:hover {
    border-color: var(--accent);
  }
</style>
