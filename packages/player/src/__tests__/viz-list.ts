// The visualiser registry, shared by the screenshot suites so they cover the same set.
// Mirrors VIZ in apps/tracker/frontend/src/lib/player-view.svelte.ts, in the same order,
// so a saved gallery reads like the picker does.
import BoingBall from "../BoingBall.svelte";
import CopperBars from "../CopperBars.svelte";
import DancerScene from "../DancerScene.svelte";
import DiscoBall from "../DiscoBall.svelte";
import Equalizer from "../Equalizer.svelte";
import FlipDots from "../FlipDots.svelte";
import GlowWave from "../GlowWave.svelte";
import HarmonyScope from "../HarmonyScope.svelte";
import LedBars from "../LedBars.svelte";
import NixieScene from "../NixieScene.svelte";
import Plasma from "../Plasma.svelte";
import SpeakerPaint from "../SpeakerPaint.svelte";
import Starfield from "../Starfield.svelte";
import Tunnel from "../Tunnel.svelte";
import VuMeters from "../VuMeters.svelte";

export const VIZ = [
  { id: "vu", comp: VuMeters },
  { id: "bars", comp: Equalizer },
  { id: "harmony", comp: HarmonyScope },
  { id: "cube", comp: LedBars },
  { id: "wave", comp: GlowWave },
  { id: "stars", comp: Starfield },
  { id: "copper", comp: CopperBars },
  { id: "plasma", comp: Plasma },
  { id: "tunnel", comp: Tunnel },
  { id: "disco", comp: DiscoBall },
  { id: "paint", comp: SpeakerPaint },
  { id: "tubes", comp: NixieScene },
  { id: "dancer", comp: DancerScene },
  { id: "flip", comp: FlipDots },
  { id: "ball", comp: BoingBall, props: { energy: 0.7, live: true, react: true } },
] as { id: string; comp: unknown; props?: Record<string, unknown> }[];

/** Lowest plausible share of the frame an effect lights, as a percentage.
 *
 *  Per-effect, because one floor for all of them is wrong: the chromagram draws a few
 *  dots on faint rings and legitimately lights around 1%, where a full-frame shader
 *  covers everything. A single threshold either passes an effect that has gone dark or
 *  fails one that is working. */
export const minFill = (id: string) => (id === "harmony" ? 0.4 : 2);

/** The 2D-canvas effects are up on the first frame; the three.js scenes have a lazy
 *  import and a scene build to get through first. */
export const settleFor = (id: string) => (id === "ball" || id === "copper" ? 600 : 2200);
