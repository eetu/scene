// The trace grid's layout, now that it sits in the module grid's frame.
//
// Two rules, and they trade against each other. Fields drop as columns narrow,
// so the ordinary tune — one chip, three voices — stays whole on a phone, which
// is what makes it music rather than a register dump. But a column is never
// half-cut or squeezed past legibility: a 2SID/3SID tune pages instead, exactly
// as a many-channel module does.
//
// Measured in a real browser because these are layout claims; jsdom would pass
// them without laying anything out.
import { mount, tick, unmount } from "svelte";
import { expect, test } from "vitest";

import { CHIP_REGS } from "../sid/registers";
import { playback } from "../state.svelte";
import VoiceTrace from "../VoiceTrace.svelte";

/** `n` frames of a plausible tune: voice 1 striking a new note every 4th frame,
 *  the others holding, so rows carry a mix of events and continuations.
 *
 *  `retrigger` drops voice 1's gate on every 4th frame, the way a play routine
 *  restarting a note does — the state the header's hold exists for. */
function seed(n: number, chips = 1, retrigger = false): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let f = 0; f < n; f++) {
    const row = new Uint8Array(CHIP_REGS * chips);
    for (let c = 0; c < chips; c++) {
      for (let v = 0; v < 3; v++) {
        const b = c * CHIP_REGS + v * 7;
        const freq = 0x2000 + (v === 0 ? Math.floor(f / 4) * 0x100 : v * 0x400);
        const gate = retrigger && v === 0 && f % 4 === 0 ? 0 : 1;
        row[b] = freq & 0xff;
        row[b + 1] = freq >> 8;
        row[b + 3] = 0x08;
        row[b + 4] = 0x40 | gate; // pulse (+ gate)
        row[b + 5] = 0x09;
        row[b + 6] = 0xa0;
      }
      row[c * CHIP_REGS + 23] = 0x75; // resonance 7 (hi nibble), voices 1+3 filtered (bits 0+2)
      row[c * CHIP_REGS + 24] = 0x1f; // low-pass, full volume
    }
    out.push(row);
  }
  return out;
}

/** PAL raster period — the spacing of the frames the decoder emits. */
const FRAME_SEC = 1 / 50.12;

/**
 * Mount the view over `rows`, with the playhead on frame `at`.
 *
 * Frames carry the time they're due and the buffer runs ahead of playback, so
 * the view is located by `playback.position` rather than by "the last row". By
 * default the playhead sits two thirds in, leaving real future rows below it —
 * which is the state the grid is normally in.
 */
async function withTrace(
  widthPx: number,
  rows: Uint8Array[],
  fn: (host: HTMLElement) => Promise<void>,
  at = Math.floor(rows.length * 0.66),
) {
  const host = document.createElement("div");
  host.style.cssText = `width:${widthPx}px;height:300px`;
  document.body.appendChild(host);
  playback.sidTrace = rows;
  playback.sidTraceAt = rows.map((_, i) => i * FRAME_SEC);
  playback.position = at * FRAME_SEC;
  playback.sidTraceDense = false;
  const app = mount(VoiceTrace, { target: host });
  // The frame sizes its columns from a `bind:clientWidth`, which is fed by a
  // ResizeObserver — that fires after `tick()`, so a single flush measures a
  // grid whose columns are still zero-width. Wait for real layout, or the first
  // assertion in a loop reads a view that hasn't been laid out yet.
  await waitForLayout(host);
  try {
    await fn(host);
  } finally {
    unmount(app);
    host.remove();
    playback.sidTrace = [];
    playback.sidTraceAt = [];
    playback.position = 0;
  }
}

/** Resolve once the grid has measured itself and given its columns a width. */
async function waitForLayout(host: HTMLElement) {
  for (let i = 0; i < 60; i++) {
    await tick();
    const cell = host.querySelector(".trow.now .vcell") as HTMLElement | null;
    if (cell && cell.getBoundingClientRect().width > 1) return;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
}

/** Cells on the newest row that are actually on screen.
 *
 *  The frame renders every column into one strip and clips it to the window, so
 *  a plain `querySelectorAll` counts columns that have been paged out of sight.
 *  Anything asserting about what the user can see has to intersect with the clip
 *  rect — that mistake made an early version of these tests pass vacuously. */
function visibleCells(host: HTMLElement): HTMLElement[] {
  const row = host.querySelector(".trow.now")!;
  const clip = row.querySelector(".clip")!.getBoundingClientRect();
  return ([...row.querySelectorAll(".vcell")] as HTMLElement[]).filter((c) => {
    const b = c.getBoundingClientRect();
    return b.right > clip.left + 1 && b.left < clip.right - 1;
  });
}

/** Visible voice columns on the newest row, and how many fields each shows. */
function shape(host: HTMLElement) {
  const cells = visibleCells(host);
  return { voices: cells.length, columns: cells[0].querySelectorAll("span").length };
}

test("a desktop width shows every field", async () => {
  await withTrace(700, seed(20), async (host) => {
    // note + wf + adsr + pw
    expect(shape(host).columns).toBe(4);
    expect(shape(host).voices).toBe(3);
  });
});

test("a phone width keeps all three voices, dropping fields instead", async () => {
  // The common case, and the one that matters most: three voices is the whole
  // harmony, and losing one to paging on a phone would lose the music.
  await withTrace(320, seed(20), async (host) => {
    const s = shape(host);
    expect(s.voices, "all three voices stay on screen").toBe(3);
    expect(s.columns, "detail is what gives way").toBeLessThan(4);
    expect(s.columns, "the note never drops").toBeGreaterThanOrEqual(1);
  });
});

test("columns are whole and legible at every width, never half-cut", async () => {
  // What the shared frame buys: rather than shrinking columns to fit, it shows
  // whole ones and pages. So the guarantee isn't "every voice is visible" — it's
  // that whatever IS visible is a complete, readable column.
  for (const chips of [1, 2, 3]) {
    for (const w of [320, 380, 480, 560, 700, 1000]) {
      await withTrace(w, seed(20, chips), async (host) => {
        const clip = host.querySelector(".trow.now .clip")!.getBoundingClientRect();
        const cells = visibleCells(host);
        expect(cells.length, `no columns at ${w}px with ${chips} chip(s)`).toBeGreaterThan(0);
        for (const c of cells) {
          const box = c.getBoundingClientRect();
          // Whole columns only: a visible one lies entirely within the window.
          expect(
            box.left >= clip.left - 1 && box.right <= clip.right + 1,
            `column half-cut at ${w}px / ${chips} chip(s): cell [${box.left}, ${box.right}] vs window [${clip.left}, ${clip.right}]`,
          ).toBe(true);
          expect(c.scrollWidth, "a field is clipped inside its column").toBeLessThanOrEqual(
            c.clientWidth + 1,
          );
        }
      });
    }
  }
});

test("a wide pane shows a 2SID tune's six voices at once", async () => {
  // Six voices fit whole when there's room; only a narrow pane pages them.
  await withTrace(1000, seed(20, 2), async (host) => {
    expect(shape(host).voices).toBe(6);
  });
});

test("a narrow pane pages a 3SID tune rather than squeezing it", async () => {
  // Nine voices in 320px cannot all be legible. The frame shows whole columns
  // and offers the pager, which is what the module grid does with 16 channels.
  await withTrace(320, seed(20, 3), async (host) => {
    const shown = visibleCells(host).length;
    expect(shown, "some voices are paged out of view").toBeLessThan(9);
    expect(shown, "but at least one whole column shows").toBeGreaterThan(0);
    // …and there's a way to reach the rest.
    expect(host.querySelectorAll("button").length, "no pager to reach them").toBeGreaterThan(0);
  });
});

test("row numbers fit their row instead of being shaved by the next one", async () => {
  // The gutter inherits the grid's body text size, which sets a line box inside
  // it regardless of how small the label is. At the small cell size the rows are
  // shorter than that box — and because the gutter is opaque and stacked above
  // the rows, the overflow isn't merely hidden, it's painted over by the rows
  // either side, so every number loses its top and bottom.
  //
  // Phone width, because that's the size that has the problem.
  await withTrace(320, seed(20), async (host) => {
    const rows = [...host.querySelectorAll(".trow")].slice(0, 6) as HTMLElement[];
    for (const row of rows) {
      const gutter = row.querySelector(".rownum") as HTMLElement;
      expect(
        gutter.getBoundingClientRect().height,
        "the row number's box is taller than its row",
      ).toBeLessThanOrEqual(row.getBoundingClientRect().height + 0.5);
    }
  });
});

test("each header sits over the voice column it names", async () => {
  // The header is windowed and translated by the same frame as the rows, so a
  // drift here means the labels describe the wrong voices after paging.
  await withTrace(700, seed(20), async (host) => {
    const head = [...host.querySelectorAll(".thcell")] as HTMLElement[];
    const row = [...host.querySelectorAll(".trow.now .vcell")] as HTMLElement[];
    expect(head).toHaveLength(row.length);
    for (let i = 0; i < head.length; i++) {
      expect(
        head[i].getBoundingClientRect().left,
        `header ${i} is out of line with its column`,
      ).toBeCloseTo(row[i].getBoundingClientRect().left, 0);
      expect(head[i].getBoundingClientRect().width).toBeCloseTo(
        row[i].getBoundingClientRect().width,
        0,
      );
    }
  });
});

test("the sounding frame sits on the centerline", async () => {
  // The tracker idiom: a fixed line, with the music passing under it. Which row
  // is "now" comes from the playback clock, not from the end of the buffer —
  // the buffer runs ahead of the audio.
  await withTrace(700, seed(80), async (host) => {
    const now = host.querySelector(".trow.now") as HTMLElement;
    const line = host.querySelector(".centerline") as HTMLElement;
    expect(host.querySelectorAll(".trow.now")).toHaveLength(1);
    expect(
      Math.abs(now.getBoundingClientRect().top - line.getBoundingClientRect().top),
      "sounding frame is off the line",
    ).toBeLessThan(2);
  });
});

test("frames that haven't sounded yet show below the line, dimmed", async () => {
  // The whole point of the lookahead: the decoder is ~1.5s in front of the
  // audio, so the rows under the line are notes you're about to hear.
  await withTrace(700, seed(80), async (host) => {
    const line = (host.querySelector(".centerline") as HTMLElement).getBoundingClientRect();
    const ahead = [...host.querySelectorAll(".trow.ahead")] as HTMLElement[];
    expect(ahead.length, "no upcoming frames rendered").toBeGreaterThan(5);
    for (const r of ahead) {
      expect(r.getBoundingClientRect().top, "an upcoming frame is above the line").toBeGreaterThan(
        line.top - 1,
      );
    }
    // Dimmed, so the future doesn't read as the present.
    expect(Number(getComputedStyle(ahead[0]).opacity)).toBeLessThan(1);
  });
});

test("the playhead follows the clock, not the end of the buffer", async () => {
  // A regression guard for the old model, where "now" was simply the last row.
  await withTrace(
    700,
    seed(80),
    async (host) => {
      const label = () => host.querySelector(".trow.now .frm")!.textContent;
      const first = label();
      playback.position = 50 * FRAME_SEC;
      await tick();
      expect(label(), "the sounding row didn't move with the clock").not.toBe(first);
    },
    20,
  );
});

test("per-voice VU bars rise from the line", async () => {
  await withTrace(700, seed(20), async (host) => {
    playback.vu = [0.9, 0.4, 0];
    await tick();
    const bars = [...host.querySelectorAll(".vubar")] as HTMLElement[];
    expect(bars).toHaveLength(3);
    // Louder voice, taller bar — and a silent one draws nothing.
    expect(bars[0].getBoundingClientRect().height).toBeGreaterThan(
      bars[1].getBoundingClientRect().height,
    );
    expect(bars[2].getBoundingClientRect().height).toBe(0);
    // They meet the line rather than floating somewhere else in the pane.
    const line = (host.querySelector(".centerline") as HTMLElement).getBoundingClientRect();
    expect(Math.abs(bars[0].getBoundingClientRect().bottom - line.top)).toBeLessThan(12);
    playback.vu = [];
  });
});

test("an empty trace says so instead of drawing an empty grid", async () => {
  await withTrace(700, [], async (host) => {
    expect(host.querySelector(".tr-empty")).not.toBeNull();
    expect(host.querySelector(".trow")).toBeNull();
  });
});

// ---------- the chip state above the grid ----------
//
// This used to be a separate "voices" tab. What it kept is what the rows have no
// column for: the pitch a voice is actually at, how it's routed, and the
// chip-wide filter and volume.

test("the chip's filter and volume show above the grid", async () => {
  await withTrace(700, seed(20), async (host) => {
    const chip = host.querySelector("[aria-label='SID 1 filter and volume']") as HTMLElement;
    expect(chip, "no chip strip").not.toBeNull();
    // The seed runs a low-pass at full volume; the lamp for the mode that IS on
    // must be the lit one, or the strip is decorative rather than a readout.
    const lit = [...chip.querySelectorAll(".modes i.lit")].map((e) => e.textContent);
    expect(lit).toEqual(["LP"]);
    expect(chip.textContent).toContain("Q7");
  });
});

test("a 2SID tune gets a strip per chip", async () => {
  await withTrace(1000, seed(20, 2), async (host) => {
    expect(host.querySelectorAll("[aria-label$='filter and volume']")).toHaveLength(2);
  });
});

test("each voice header reads its own pitch and routing", async () => {
  await withTrace(1000, seed(20), async (host) => {
    const heads = [...host.querySelectorAll(".vhead")] as HTMLElement[];
    expect(heads).toHaveLength(3);
    // Every voice in the seed is gated, so all three read a frequency rather
    // than the idle dash.
    for (const h of heads) expect(h.querySelector(".vhz")!.textContent).toContain("Hz");
    // The seed filters voices 1 and 3 — the flag is per voice, and it is the
    // one thing here the grid's columns cannot show at all.
    const filtered = heads.map((h) => h.querySelectorAll(".flags i.lit").length);
    expect(filtered).toEqual([1, 0, 1]);
  });
});

test("a retriggering voice holds rather than strobing", async () => {
  // A play routine drops the gate for a single frame to restart a note. At 50
  // frames a second that reads as a voice flickering off and on; a voice
  // retriggering steadily is continuously sounding, so the header holds it.
  await withTrace(
    1000,
    seed(40, 1, true),
    async (host) => {
      const v1 = () => host.querySelector(".vhead") as HTMLElement;
      // Land the playhead exactly on a gate-low frame — the worst case.
      for (const at of [20, 24, 28]) {
        playback.position = at * FRAME_SEC;
        await tick();
        expect(v1().className, `voice 1 dropped out on frame ${at}`).toContain("on");
      }
    },
    20,
  );
});

test("a voice that stops really does go quiet", async () => {
  // The hold must not be so generous that it never lets go, or it stops being a
  // readout of the chip.
  const rows = seed(40);
  for (const row of rows.slice(20)) row[4] &= ~1; // voice 1 gate off from frame 20
  await withTrace(
    1000,
    rows,
    async (host) => {
      const v1 = () => host.querySelector(".vhead") as HTMLElement;
      expect(v1().className).toContain("on");
      playback.position = 39 * FRAME_SEC;
      await tick();
      expect(v1().className, "voice 1 never released").not.toContain("on");
      expect(v1().querySelector(".vhz")!.textContent).toBe("—");
    },
    10,
  );
});

test("a sample-streaming tune says the rows aren't the whole story", async () => {
  await withTrace(700, seed(10), async (host) => {
    expect(host.querySelector(".lossy")).toBeNull();
    playback.sidTraceDense = true;
    await tick();
    expect(host.querySelector(".lossy")).not.toBeNull();
  });
});
