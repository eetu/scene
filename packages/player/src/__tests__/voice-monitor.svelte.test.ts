// The voice monitor's geometry must not move while a tune plays.
//
// It renders live chip state at ~43 Hz, so anything whose SIZE depends on that
// state re-lays out dozens of times a second and the whole list visibly jitters.
// Content changing is the point; the boxes holding it changing is the bug. These
// measure real layout in a real browser, because that's the only place the
// failure exists — jsdom has no layout and would pass either way.
import { mount, tick, unmount } from "svelte";
import { expect, test } from "vitest";

import { CHIP_REGS } from "../sid/registers";
import { playback } from "../state.svelte";
import VoiceMonitor from "../VoiceMonitor.svelte";

/** One chip's registers with every voice in a given state.
 *
 *  `gate` is the interesting axis: it toggles on every note, up to 50 times a
 *  second on a fast tune. */
function regs(opts: { gate: boolean; wave?: number; flags?: number }): number[] {
  const r = new Array(CHIP_REGS).fill(0);
  for (let v = 0; v < 3; v++) {
    const b = v * 7;
    r[b] = 0x00; // frequency lo
    r[b + 1] = 0x20; // frequency hi → an audible note
    r[b + 2] = 0x00;
    r[b + 3] = 0x08; // pulse width
    r[b + 4] = (opts.wave ?? 0x40) | (opts.flags ?? 0) | (opts.gate ? 1 : 0);
    r[b + 5] = 0x59; // attack/decay
    r[b + 6] = 0x8a; // sustain/release
  }
  r[24] = 0x1f; // low-pass + full volume
  return r;
}

async function withMonitor(fn: (host: HTMLElement) => Promise<void>) {
  const host = document.createElement("div");
  host.style.cssText = "width:420px";
  document.body.appendChild(host);
  const app = mount(VoiceMonitor, { target: host });
  try {
    await fn(host);
  } finally {
    unmount(app);
    host.remove();
    playback.sidRegs = [];
    playback.vu = [];
  }
}

/** Heights of every voice strip, after letting Svelte flush. */
async function rowHeights(host: HTMLElement, r: number[]): Promise<number[]> {
  playback.sidRegs = r;
  await tick();
  return [...host.querySelectorAll(".voice")].map((e) => e.getBoundingClientRect().height);
}

test("a voice strip keeps its height when the gate toggles", async () => {
  await withMonitor(async (host) => {
    const on = await rowHeights(host, regs({ gate: true }));
    const off = await rowHeights(host, regs({ gate: false }));
    expect(on).toHaveLength(3);
    expect(on.every((h) => h > 0)).toBe(true);
    // Gating drives the note's frequency readout. If that readout collapses when
    // it empties, the row shrinks and every row below it jumps.
    expect(off).toEqual(on);
  });
});

test("a voice strip keeps its height when the waveform changes", async () => {
  await withMonitor(async (host) => {
    // Pulse shows a pulse-width bar that the other waveforms don't.
    const pulse = await rowHeights(host, regs({ gate: true, wave: 0x40 }));
    const saw = await rowHeights(host, regs({ gate: true, wave: 0x20 }));
    const noise = await rowHeights(host, regs({ gate: true, wave: 0x80 }));
    expect(saw).toEqual(pulse);
    expect(noise).toEqual(pulse);
  });
});

test("a voice strip keeps its height when sync / ring / filter flags appear", async () => {
  await withMonitor(async (host) => {
    const plain = await rowHeights(host, regs({ gate: true }));
    // sync (bit1) + ring (bit2) + test (bit3) all lit at once.
    const flagged = await rowHeights(host, regs({ gate: true, flags: 0x0e }));
    expect(flagged).toEqual(plain);
  });
});

test("a retriggering voice reads as active instead of strobing", async () => {
  // The registers are sampled at ~43 Hz while the tune drives the chip at 50 Hz,
  // so a steadily retriggering voice is caught mid-gate about as often as not.
  // Without a hold the strip flips between its two opacities continuously.
  await withMonitor(async (host) => {
    const strip = () => host.querySelector(".voice")!;

    await rowHeights(host, regs({ gate: true }));
    expect(strip().classList.contains("on")).toBe(true);

    // The very next sample catches the gate low — mid-retrigger, not silence.
    await rowHeights(host, regs({ gate: false }));
    expect(strip().classList.contains("on"), "held through a gate gap").toBe(true);

    // A voice that genuinely stops does go quiet, once the hold lapses.
    await new Promise((r) => setTimeout(r, 220));
    await rowHeights(host, regs({ gate: false }));
    expect(strip().classList.contains("on"), "released after the hold").toBe(false);
  });
});

test("the note readout holds between retriggers rather than blanking", async () => {
  await withMonitor(async (host) => {
    const note = () => host.querySelector(".voice .note")!.textContent!.trim();

    await rowHeights(host, regs({ gate: true }));
    const sounding = note();
    expect(sounding).not.toBe("—");

    await rowHeights(host, regs({ gate: false }));
    expect(note(), "same note, not a dash, mid-retrigger").toContain(sounding.split(/\s+/)[0]);
  });
});

test("the monitor's overall height is stable across chip states", async () => {
  await withMonitor(async (host) => {
    const vm = host.querySelector(".vm")!;
    playback.sidRegs = regs({ gate: true });
    await tick();
    const a = vm.getBoundingClientRect().height;
    playback.sidRegs = regs({ gate: false, wave: 0x10, flags: 0x0e });
    await tick();
    const b = vm.getBoundingClientRect().height;
    expect(b).toBe(a);
  });
});
