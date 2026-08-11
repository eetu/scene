// @scene/player — the vendored libopenmpt (chiptune3) playback engine, its
// reactive store, and the transport views (pattern grid + output scope).
// App wiring: call setPlayerHost({ appName, fileUrl, play, putMeta }) once at
// startup, then drive `playback` + the exported transport functions.
export * from "./host";
export * from "./player.svelte";
export { type FpsMode, perf } from "./perf.svelte";
export { crt, CRT_OPTIONS, crtSuits, mountCrt, setCrt, toggleCrt } from "./crt.svelte";
export { default as BoingBall } from "./BoingBall.svelte";
export { default as ChannelPager } from "./ChannelPager.svelte";
export { default as ChannelScope } from "./ChannelScope.svelte";
export { CELL_W, channelWindow, type ChannelWindow, ROWNUM_W } from "./channel-window";
export { pageSwipe } from "./pageSwipe";
export { default as DancerScene } from "./DancerScene.svelte";
export { default as C64Screen } from "./C64Screen.svelte";
export { default as CopperBars } from "./CopperBars.svelte";
export { default as DiscoBall } from "./DiscoBall.svelte";
export { default as FlipDots } from "./FlipDots.svelte";
export { flip, setFlipMode } from "./flip-mode.svelte";
export { fmtTime, hex2 } from "./format";
export { readPref, writePref } from "./persist";
export { type FlipMode, FLIP_MODES, isFlipMode } from "./flip-modes";
export { default as GlowWave } from "./GlowWave.svelte";
export { default as HarmonyScope } from "./HarmonyScope.svelte";
export { default as HiFiDeck } from "./HiFiDeck.svelte";
export { setVfdFace, type VfdFace, VFD_FACES, vfdView } from "./vfd-mode.svelte";
export { default as LedBars } from "./LedBars.svelte";
export { default as NixieScene } from "./NixieScene.svelte";
export { default as PatternView } from "./PatternView.svelte";
export { default as SampleBrowser } from "./SampleBrowser.svelte";
export { default as TrackGrid } from "./TrackGrid.svelte";
export { default as VoiceTrace } from "./VoiceTrace.svelte";
export { decodeChips, freqToHz, noteFor, PAL_CLOCK } from "./sid/registers";
export type { Chip, Voice, Waveform } from "./sid/registers";
export { type BoardMode, BOARD_MODES, boardView, setBoardMode } from "./board-mode.svelte";
export { default as ScrollerBoard } from "./ScrollerBoard.svelte";
export { default as NeonDrive } from "./NeonDrive.svelte";
export { default as Plasma } from "./Plasma.svelte";
export { default as Starfield } from "./Starfield.svelte";
export { default as Tunnel } from "./Tunnel.svelte";
export { default as VuMeters } from "./VuMeters.svelte";
export { default as PlayerStage } from "./PlayerStage.svelte";
export { default as Scope } from "./Scope.svelte";
export { default as Transport } from "./Transport.svelte";
