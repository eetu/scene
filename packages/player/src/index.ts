// @scene/player — the vendored libopenmpt (chiptune3) playback engine, its
// reactive store, and the transport views (pattern grid + output scope).
// App wiring: call setPlayerHost({ appName, fileUrl, play, putMeta }) once at
// startup, then drive `playback` + the exported transport functions.
export * from './host';
export * from './player.svelte';
export { default as BoingBall } from './BoingBall.svelte';
export { default as PatternView } from './PatternView.svelte';
export { default as PlayerStage } from './PlayerStage.svelte';
export { default as Scope } from './Scope.svelte';
export { default as Transport } from './Transport.svelte';
