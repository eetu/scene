// @scene/player — the vendored libopenmpt (chiptune3) playback engine, its
// reactive store, and the transport views (pattern grid + output scope).
// App wiring: call setPlayerHost({ appName, fileUrl, play, putMeta }) once at
// startup, then drive `playback` + the exported transport functions.
export * from "./host";
export * from "./player.svelte";
export { default as BoingBall } from "./BoingBall.svelte";
export { default as ChannelPager } from "./ChannelPager.svelte";
export { default as ChannelScope } from "./ChannelScope.svelte";
export { CELL_W, channelWindow, type ChannelWindow, ROWNUM_W } from "./channel-window";
export { pageSwipe } from "./pageSwipe";
export { default as CopperBars } from "./CopperBars.svelte";
export { default as DiscoBall } from "./DiscoBall.svelte";
export { default as Equalizer } from "./Equalizer.svelte";
export { default as GlowWave } from "./GlowWave.svelte";
export { default as LedBars } from "./LedBars.svelte";
export { default as NixieScene } from "./NixieScene.svelte";
export { default as PatternView } from "./PatternView.svelte";
export { default as SampleBrowser } from "./SampleBrowser.svelte";
export { default as Plasma } from "./Plasma.svelte";
export { default as Starfield } from "./Starfield.svelte";
export { default as Tunnel } from "./Tunnel.svelte";
export { default as VuMeters } from "./VuMeters.svelte";
export { default as PlayerStage } from "./PlayerStage.svelte";
export { default as Scope } from "./Scope.svelte";
export { default as Transport } from "./Transport.svelte";
