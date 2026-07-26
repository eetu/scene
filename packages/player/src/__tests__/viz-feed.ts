// Synthetic audio + theme feed, so a browser test can render any visualiser as
// it looks under real music. Plain .ts, not .svelte.ts: this is a helper, not a
// rune module.
//
// The analyser is FAKED rather than driven by a real AudioContext. Headless
// chromium won't start one without a user gesture, and a fake gives something
// better anyway: an exactly reproducible signal, including the frame-to-frame
// FFT jitter that a real analyser has and that some effects amplify.
import { setScopeSource, SPECTRUM_SIZE } from "../scope";
import { playback } from "../state.svelte";

const BPM = 125; // the tracker default, so the beat grid is the familiar one
const SAMPLE_RATE = 48000;

// Deterministic value noise. A real FFT frame fluctuates bin-to-bin and
// frame-to-frame even on a steady tone; effects that map a band straight onto
// geometry pick that up as chatter, which is exactly what we want to see.
function noise(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Band energies for a moment in the loop: a kick on every beat, a chord
 *  swelling over the bar, hats on the eighths. */
export function envelopes(t: number) {
  const beats = (t * BPM) / 60;
  const inBeat = beats % 1;
  const inEighth = (beats * 2) % 1;
  return {
    bass: 0.86 * Math.exp(-inBeat * 5.5) + 0.1,
    mid: 0.44 + 0.16 * Math.sin((beats / 4) * Math.PI * 2),
    treble: 0.32 * Math.exp(-inEighth * 12) + 0.07,
    beats,
  };
}

export type VizFeed = { stop: () => void; jitter: number };

/**
 * Install the feed and start driving `playback`. `jitter` scales the per-bin FFT
 * noise: 1 is realistic, 0 gives a perfectly smooth signal — the difference
 * isolates how much of an effect's motion is the music and how much is chatter.
 *
 * `gain` scales the whole signal. Worth sweeping before concluding anything about
 * how well an effect fills its frame: a meter with headroom for a loud track looks
 * under-used on a quiet one, and that's the feed's fault, not the viz's.
 */
export function startVizFeed(opts: { jitter?: number; gain?: number } = {}): VizFeed {
  const jitter = opts.jitter ?? 1;
  const gain = opts.gain ?? 1;
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;

  const hzPerBin = SAMPLE_RATE / 2 / SPECTRUM_SIZE;

  // Narrow spectral peaks on top of the broadband bed — an A minor triad across three
  // octaves. Real music has pitched partials, and effects that look for them found
  // nothing in a smooth rolloff: the chromagram in particular lit no pitch classes at
  // all, which is a property of the signal rather than of the effect.
  const PARTIALS = [110, 220, 261.63, 329.63, 440, 523.25, 659.26, 880];

  const fake = {
    fftSize: SPECTRUM_SIZE * 2,
    frequencyBinCount: SPECTRUM_SIZE,
    context: { sampleRate: SAMPLE_RATE },
    getByteFrequencyData(buf: Uint8Array) {
      const t = now();
      const { bass, mid, treble } = envelopes(t);
      const frame = Math.floor(t * 60); // hold a frame's noise for a frame
      for (let i = 0; i < buf.length; i++) {
        const hz = i * hzPerBin;
        const band = hz < 200 ? bass : hz < 2000 ? mid : treble;
        // Spectra fall off with frequency; without it every bar reads level.
        const rolloff = 1 / (1 + hz / 900);
        const n = 1 + jitter * (noise(i, frame) - 0.5) * 0.5;
        let v = band * rolloff * 340 * n * gain;
        // Add any partial landing in this bin, weighted by the band it sits in.
        for (const f of PARTIALS) {
          const d = Math.abs(hz - f) / hzPerBin;
          if (d < 1.6) {
            const w = f < 200 ? bass : f < 2000 ? mid : treble;
            v += (1 - d / 1.6) * w * 300 * gain;
          }
        }
        buf[i] = Math.max(0, Math.min(255, v));
      }
    },
    getByteTimeDomainData(buf: Uint8Array) {
      const t = now();
      const { bass, mid, treble } = envelopes(t);
      for (let i = 0; i < buf.length; i++) {
        const s = i / SAMPLE_RATE;
        const v =
          bass * Math.sin(2 * Math.PI * 55 * (t + s)) +
          mid * 0.5 * Math.sin(2 * Math.PI * 440 * (t + s)) +
          treble * 0.3 * Math.sin(2 * Math.PI * 3200 * (t + s));
        buf[i] = Math.max(0, Math.min(255, 128 + v * 70));
      }
    },
  };
  setScopeSource(fake as unknown as AnalyserNode);

  // A module the vizzes can key off — the dancer picks its clip and palette from
  // the hash, so a fixed one keeps the gallery reproducible.
  playback.current = {
    hash: "0f1e2d3c4b5a6978",
    filename: "gallery.mod",
    title: "Gallery",
    artist: "Test",
    channels: 8,
    duration: 210,
  };
  playback.playing = true;
  playback.paused = false;
  playback.duration = 210;
  playback.samples = ["kick", "snare", "hat", "bass", "lead", "pad", "arp", "fx"];

  let lastBeat = -1;
  let raf = 0;
  const tick = () => {
    const t = now();
    const { beats, bass, mid, treble } = envelopes(t);

    // Per-channel VU: eight channels on staggered decays, so meters and
    // channel-driven effects see plausible independent movement.
    const vu: number[] = [];
    for (let c = 0; c < 8; c++) {
      const off = (c * 0.25) % 1;
      const ph = (beats + off) % 1;
      const src = c < 2 ? bass : c < 5 ? mid : treble;
      vu.push(Math.max(0, Math.min(1, src * (0.5 + Math.exp(-ph * 4)) * 0.9)));
    }
    playback.vu = vu;

    const b = Math.floor(beats);
    if (b !== lastBeat) {
      lastBeat = b;
      playback.beat++;
    }
    playback.position = 12 + t;
    playback.row = Math.floor(beats * 4) % 64;
    playback.pattern = 3;
    playback.order = 2;

    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    jitter,
    stop() {
      cancelAnimationFrame(raf);
      setScopeSource(null);
      playback.playing = false;
      playback.vu = [];
    },
  };
}

/** The app tokens the visualisers read. Without these they fall back to
 *  hard-coded defaults and the screenshots wouldn't be what ships. */
export function installTheme(theme: "dark" | "light" = "dark") {
  const halo =
    theme === "dark"
      ? {
          "--halo-body": "#0f0f0f",
          "--halo-bg-main": "#252525",
          "--halo-bg-light": "#1c1c1c",
          "--halo-text-main": "#d6d6d6",
          "--halo-text-muted": "#8a8a8a",
          "--halo-text-light": "#646464",
          "--halo-border": "#1f1f1f",
          "--halo-off-bg": "#404040",
        }
      : {
          "--halo-body": "#f7f7f7",
          "--halo-bg-main": "#ffffff",
          "--halo-bg-light": "#fbfbfb",
          "--halo-text-main": "#525252",
          "--halo-text-muted": "#6b6b6b",
          "--halo-text-light": "#8a8a8a",
          "--halo-border": "#e2e2e2",
          "--halo-off-bg": "#d4d4d4",
        };
  const app = {
    "--halo-accent": "#f78f08",
    "--halo-accent-soft": "rgba(247, 143, 8, 0.2)",
    "--bg": "var(--halo-body)",
    "--panel": "var(--halo-bg-main)",
    "--panel-hi": "var(--halo-off-bg)",
    "--border": "var(--halo-border)",
    "--text": "var(--halo-text-main)",
    "--muted": "var(--halo-text-muted)",
    "--accent": "var(--halo-accent)",
    "--accent-dim": "var(--halo-accent-soft)",
    "--surface": "var(--halo-body)",
    "--surface-2": "var(--halo-bg-light)",
    "--surface-bar": "var(--halo-bg-light)",
    "--surface-line": "var(--halo-border)",
    "--surface-line-2": "var(--halo-off-bg)",
    "--surface-fg": "var(--halo-text-muted)",
    "--surface-fg-beat": "var(--halo-text-main)",
    "--surface-fg-active": "var(--halo-text-main)",
    "--surface-fg-dim": "var(--halo-text-light)",
    "--scope-bg": "var(--halo-body)",
    "--scope-grid": "var(--halo-off-bg)",
    "--font-retro": "ui-monospace, monospace",
    "--font-mono-retro": "ui-monospace, monospace",
  };
  for (const [k, v] of Object.entries({ ...halo, ...app })) {
    document.documentElement.style.setProperty(k, v);
  }
  document.documentElement.dataset.theme = theme;
  document.body.style.margin = "0";
  document.body.style.background = "#0f0f0f";
}
