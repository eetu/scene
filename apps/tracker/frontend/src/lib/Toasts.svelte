<script lang="ts">
  // Transient confirmation / error banner. Presentational: the parent owns the
  // trigger (showToast) + auto-dismiss; this just renders the current toast.
  let { toast }: { toast: { msg: string; kind: "ok" | "err" } | null } = $props();
</script>

{#if toast}
  <div class="toast" class:err={toast.kind === "err"} role="status">{toast.msg}</div>
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: 76px;
    transform: translateX(-50%);
    z-index: 20;
    max-width: calc(100vw - 32px);
    padding: 8px 14px;
    background: var(--panel-hi);
    border: 1px solid var(--accent);
    border-radius: 6px;
    color: var(--text);
    font-size: 13px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .toast.err {
    border-color: var(--halo-error);
    color: var(--halo-error);
  }
</style>
