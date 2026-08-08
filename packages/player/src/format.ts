// Tiny display formatters shared across the player surfaces.

/** m:ss — the transport/list duration format ("0:00" for missing/∞). */
export function fmtTime(sec: number): string {
  if (!sec || !isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Two-digit uppercase hex — tracker row/order/sample numbering. */
export function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, "0");
}
