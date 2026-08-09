// The visualiser registry, shared by the screenshot suites so they cover the same set.
// Mirrors VIZ in apps/tracker/frontend/src/lib/player-view.svelte.ts, in the same order,
// so a saved gallery reads like the picker does.
import BoingBall from "../BoingBall.svelte";
import C64Screen from "../C64Screen.svelte";
import CopperBars from "../CopperBars.svelte";
import DancerScene from "../DancerScene.svelte";
import DiscoBall from "../DiscoBall.svelte";
import FlipDots from "../FlipDots.svelte";
import GlowWave from "../GlowWave.svelte";
import HarmonyScope from "../HarmonyScope.svelte";
import HiFiDeck from "../HiFiDeck.svelte";
import LedBars from "../LedBars.svelte";
import NixieScene from "../NixieScene.svelte";
import Plasma from "../Plasma.svelte";
import ScrollerBoard from "../ScrollerBoard.svelte";
import Starfield from "../Starfield.svelte";
import Tunnel from "../Tunnel.svelte";
import VuMeters from "../VuMeters.svelte";

export const VIZ = [
  { id: "vu", comp: VuMeters },
  { id: "flip", comp: FlipDots },
  { id: "board", comp: ScrollerBoard },
  { id: "hifi", comp: HiFiDeck },
  { id: "harmony", comp: HarmonyScope },
  { id: "cube", comp: LedBars },
  { id: "wave", comp: GlowWave },
  { id: "stars", comp: Starfield },
  { id: "copper", comp: CopperBars },
  { id: "plasma", comp: Plasma },
  { id: "tunnel", comp: Tunnel },
  { id: "disco", comp: DiscoBall },
  { id: "tubes", comp: NixieScene },
  { id: "c64", comp: C64Screen },
  { id: "dancer", comp: DancerScene },
  { id: "ball", comp: BoingBall, props: { energy: 0.7, live: true, react: true } },
] as { id: string; comp: unknown; props?: Record<string, unknown> }[];

/** Lowest plausible share of the frame an effect lights, as a percentage.
 *
 *  Per-effect, because one floor for all of them is wrong: the chromagram draws a few
 *  dots on faint rings and legitimately lights around 1%, where a full-frame shader
 *  covers everything. A single threshold either passes an effect that has gone dark or
 *  fails one that is working. */
export const minFill = (id: string) => (id === "harmony" ? 0.4 : 2);

/** Lowest plausible frame-to-frame change, as a percentage.
 *
 *  Zero for the scroller board, and only for it: it is the one visualiser whose
 *  resting state is the point. It holds a page for ~15s so the words can be read, so
 *  across the gallery's two frames it is usually mid-hold and measures 0. That it
 *  turns the page at all is asserted where the timescale suits it —
 *  scroller-board.svelte.test.ts waits out a full hold and compares the text. */
export const minMotion = (id: string) => (id === "board" ? 0 : 0.05);

/** The 2D-canvas effects are up on the first frame; the object scenes have a
 *  import and a scene build to get through first.
 *
 *  `c64` is neither: it boots a machine, loads a tape and only then starts its first
 *  demo part, which opens behind a wipe. Waited past all of that — shooting during
 *  the wipe would gallery a screen of solid colour. */
export const settleFor = (id: string) =>
  id === "ball" || id === "copper" ? 600 : id === "board" ? 3500 : id === "c64" ? 5000 : 2200;
