// The C64 demo: the screen model, the parts, and the running order.
//
// Worth testing without a canvas because this is where the demo actually lives —
// the renderer only blits screen codes. The claims here are the ones a screenshot
// can't make on its own: that every part in the order draws something and keeps
// drawing, that nothing writes a colour the VIC-II didn't have or a cell off the
// screen, and that the parts never trample the scroller running underneath them.
import { describe, expect, test } from "vitest";

import { createDemo, scrollText, stepDemo, type Feed } from "../c64-demo";
import { VIC_PALETTE } from "../c64-palette";
import {
  createFire,
  createStars,
  fire,
  logo,
  PART_NAMES,
  PART_ROWS,
  plasma,
  RUNNING_ORDER,
  scope,
  starfield,
  twister,
  vectorBalls,
  wrapBig,
} from "../c64-parts";
import {
  bigWidth,
  CHAR,
  clear,
  COLS,
  createScreen,
  poke,
  print,
  printBig,
  reverse,
  ROWS,
  screenCode,
  SOLID,
  SPACE,
} from "../c64-screen";

const DT = 1 / 60;

const feed = (over: Partial<Feed> = {}): Feed => ({
  bass: 0.5,
  mid: 0.4,
  treble: 0.3,
  beat: 0,
  wave: [],
  title: "COMMANDO",
  lines: ["COMMANDO", "BY ROB HUBBARD"],
  ...over,
});

/** Run the demo forward in plausible frames. */
function run(seconds: number, over: Partial<Feed> = {}, key = "") {
  const d = createDemo(key);
  for (let t = 0; t < seconds; t += DT) stepDemo(d, DT, feed(over));
  return d;
}

/** Cells in the part area that aren't blank. */
const inked = (d: ReturnType<typeof createDemo>) =>
  [...d.screen.chars.slice(0, PART_ROWS * COLS)].filter((c) => c !== SPACE).length;

const textOf = (chars: Uint8Array) =>
  [...chars].map((c) => (c === SPACE ? " " : String.fromCharCode(c < 27 && c > 0 ? c + 64 : c)));

describe("the screen", () => {
  test("is 40x25 of screen RAM and colour RAM", () => {
    const s = createScreen();
    expect(s.chars).toHaveLength(COLS * ROWS);
    expect(s.colors).toHaveLength(COLS * ROWS);
  });

  test("screen codes are not ASCII", () => {
    // The trap this encoding exists for: A is 1, not 65, and only the run from
    // space to '?' coincides with ASCII. Getting it wrong renders a screen of
    // graphics characters that looks deliberate.
    expect(screenCode("@")).toBe(0);
    expect(screenCode("A")).toBe(1);
    expect(screenCode("Z")).toBe(26);
    expect(screenCode("a"), "the unshifted set has no lower case").toBe(1);
    expect(screenCode(" ")).toBe(0x20);
    expect(screenCode("0")).toBe(0x30);
    expect(screenCode("?")).toBe(0x3f);
  });

  test("reverse video is the top half of the table", () => {
    expect(reverse(SPACE)).toBe(SOLID);
    expect(CHAR.TOP_HALF).toBe(reverse(CHAR.BOTTOM_HALF));
  });

  test("the fill ramp climbs from empty to solid", () => {
    // These codes were read out of the font, not off a PETSCII chart. If the
    // ramp is out of order every effect built on it shades backwards.
    expect(CHAR.FILL[0]).toBe(SPACE);
    expect(CHAR.FILL[8]).toBe(SOLID);
    expect(CHAR.FILL).toHaveLength(9);
    expect(new Set(CHAR.FILL).size, "a duplicate step is a flat spot").toBe(9);
  });

  test("print lands where it's told and clips at the edge", () => {
    const s = createScreen();
    print(s, 2, 1, "HI", 5);
    expect(s.chars[1 * COLS + 2]).toBe(screenCode("H"));
    expect(s.colors[1 * COLS + 2]).toBe(5);
    // Off the right edge: clipped, and specifically not wrapped onto the next
    // row, which would corrupt whatever is drawn there.
    print(s, COLS - 1, 3, "AB", 1);
    expect(s.chars[3 * COLS + (COLS - 1)]).toBe(screenCode("A"));
    expect(s.chars[4 * COLS]).toBe(SPACE);
  });

  test("poke ignores cells off the screen rather than wrapping", () => {
    const s = createScreen();
    clear(s, 0);
    poke(s, -1, 0, SOLID, 1);
    poke(s, 0, ROWS, SOLID, 1);
    expect([...s.chars].every((c) => c === SPACE)).toBe(true);
  });

  test("clear can spare the rows it wasn't given", () => {
    // The contract the whole split-screen layout rests on.
    const s = createScreen();
    poke(s, 0, ROWS - 1, SOLID, 1);
    clear(s, 0, PART_ROWS);
    expect(s.chars[(ROWS - 1) * COLS]).toBe(SOLID);
  });
});

describe("block letters", () => {
  test("a word measures what it draws", () => {
    const s = createScreen();
    printBig(s, 0, 0, "AB", 1);
    const lit = [...s.chars].map((c, i) => (c !== SPACE ? i % COLS : -1)).filter((x) => x >= 0);
    expect(Math.max(...lit)).toBeLessThan(bigWidth("AB"));
  });

  test("every letter and digit has a shape", () => {
    // A missing entry draws nothing at all, so a logo silently loses characters.
    const s = createScreen();
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      clear(s, 0);
      printBig(s, 0, 0, ch, 1);
      expect(
        [...s.chars].some((c) => c !== SPACE),
        `${ch} has no glyph`,
      ).toBe(true);
    }
  });

  test("wrapping breaks on words, and on long ones anyway", () => {
    expect(wrapBig("rob hubbard", 8)).toEqual(["ROB", "HUBBARD"]);
    // A single word wider than the screen has to break mid-word — the
    // alternative is a line that runs off the edge.
    expect(wrapBig("supercalifragilistic", 8)).toEqual(["SUPERCAL", "IFRAGILI", "STIC"]);
    // Three lines of block type is all that fits above the scroller.
    expect(wrapBig("a b c d e f g h", 8).length).toBeLessThanOrEqual(3);
  });
});

describe("the parts", () => {
  const PARTS: [string, (s: ReturnType<typeof createScreen>, t: number) => void][] = [
    ["plasma", (s, t) => plasma(s, t, feed())],
    ["twister", (s, t) => twister(s, t, feed())],
    ["balls", (s, t) => vectorBalls(s, t, feed())],
    ["logo", (s, t) => logo(s, t, feed())],
    ["scope", (s, t) => scope(s, t, feed({ wave: sine(t) }))],
  ];

  const sine = (t: number) =>
    Array.from({ length: 64 }, (_, i) => 128 + Math.round(Math.sin(i * 0.3 + t) * 100));

  test.each(PARTS)("%s draws something at every moment", (_name, draw) => {
    const s = createScreen();
    for (let t = 0; t < 20; t += 0.37) {
      clear(s, 0);
      draw(s, t);
      expect([...s.chars.slice(0, PART_ROWS * COLS)].some((c) => c !== SPACE)).toBe(true);
    }
  });

  test.each(PARTS)("%s stays in its own rows", (_name, draw) => {
    // The scroller lives below PART_ROWS. A part that writes there erases the
    // one thing that runs through the whole demo.
    const s = createScreen();
    for (let t = 0; t < 20; t += 0.53) {
      clear(s, 0);
      for (let i = PART_ROWS * COLS; i < s.chars.length; i++) s.chars[i] = CHAR.DISC;
      draw(s, t);
      for (let i = PART_ROWS * COLS; i < s.chars.length; i++) {
        expect(s.chars[i], `wrote into the scroller strip at cell ${i}`).toBe(CHAR.DISC);
      }
    }
  });

  test("the simulations keep going instead of burning out", () => {
    // Fire and stars carry state between frames, so they can converge on an
    // empty screen in a way the stateless parts can't.
    const s = createScreen();
    const f = createFire();
    for (let i = 0; i < 600; i++) fire(s, f, feed({ bass: 0 }));
    expect(
      [...s.chars.slice(0, PART_ROWS * COLS)].filter((c) => c !== SPACE).length,
    ).toBeGreaterThan(PART_ROWS * COLS * 0.2);

    const st = createStars();
    for (let i = 0; i < 600; i++) starfield(s, st, DT, feed());
    expect(
      [...s.chars.slice(0, PART_ROWS * COLS)].filter((c) => c !== SPACE).length,
    ).toBeGreaterThan(10);
  });

  test("every part has a name to announce itself with", () => {
    for (const id of RUNNING_ORDER) expect(PART_NAMES[id], `${id} is unnamed`).toBeTruthy();
  });
});

describe("the demo", () => {
  test("boots, loads, and reaches the running order", () => {
    expect(run(0.2).phase).toBe("boot");
    expect(run(1.3).phase).toBe("typing");
    expect(run(2.0).phase).toBe("loading");
    expect(run(4.0).phase).toBe("part");
  });

  test("the LOAD line names the tune", () => {
    expect(textOf(run(2.0, { title: "Monty on the Run" }).screen.chars).join("")).toContain(
      'LOAD"MONTY ON THE R',
    );
  });

  test("a tune with no title still has something to load", () => {
    // A SID with no PSID name must not produce LOAD"",8,1 — an empty filename
    // reads as a bug in the player rather than as a missing tag.
    expect(textOf(run(2.5, { title: "" }).screen.chars).join("")).toContain('LOAD"TUNE",8,1');
  });

  test("it works through the running order rather than stopping on one part", () => {
    const seen = new Set<number>();
    const d = createDemo();
    for (let t = 0; t < 4 + 16 * RUNNING_ORDER.length; t += DT) {
      stepDemo(d, DT, feed());
      if (d.phase === "part") seen.add(d.part);
    }
    expect(seen.size, "the demo never advanced past its opening part").toBe(RUNNING_ORDER.length);
  });

  test("different tunes open on different parts", () => {
    // Same habit CopperBars has: variety without a control to find, and stable
    // per tune so a screenshot of one is reproducible.
    const opener = (key: string) => createDemo(key).part;
    const parts = new Set(["a", "hubbard", "commando", "zzz", "q", "delta"].map(opener));
    expect(parts.size, "every tune opened on the same part").toBeGreaterThan(1);
    expect(opener("hubbard")).toBe(opener("hubbard"));
  });

  test("the screen is never blank once the demo is running", () => {
    // Including across the wipes between parts, which is exactly where a
    // sequencing bug would show as a flash of nothing.
    const d = createDemo();
    for (let t = 0; t < 4; t += DT) stepDemo(d, DT, feed());
    for (let t = 0; t < 40; t += DT) {
      stepDemo(d, DT, feed());
      expect(inked(d), "the screen went blank mid-demo").toBeGreaterThan(0);
    }
  });

  test("the scroller wraps instead of running out of script", () => {
    const d = createDemo();
    for (let t = 0; t < 120; t += DT) stepDemo(d, DT, feed());
    expect(d.scrollX).toBeLessThan(scrollText(feed().lines).length);
  });

  test("the script enters from the right rather than starting mid-word", () => {
    expect(scrollText(["ABC"]).slice(0, COLS)).toBe(" ".repeat(COLS));
  });

  test("an empty script still scrolls something", () => {
    expect(scrollText([]).trim()).not.toBe("");
    expect(scrollText(["", "  "]).trim()).not.toBe("");
  });

  test("the border catches the beat and lets go", () => {
    const d = createDemo();
    for (let t = 0; t < 5; t += DT) stepDemo(d, DT, feed());
    const resting = d.screen.border;
    stepDemo(d, DT, feed({ beat: 1 }));
    expect(d.screen.border, "the beat didn't flash the border").not.toBe(resting);
    // The counter not advancing means no new beat — the flash must decay.
    for (let t = 0; t < 0.5; t += DT) stepDemo(d, DT, feed({ beat: 1 }));
    expect(d.screen.border).toBe(resting);
  });

  test("every colour it emits is one the VIC-II had", () => {
    // The palette is the picture. A colour index off the end of it renders as
    // undefined and paints nothing at all — a hole in the screen, not an error.
    //
    // Gathered over a full pass of the running order and asserted once: this
    // inspects a thousand cells a frame, and an expect() per cell costs more
    // than every other test in the file put together.
    const d = createDemo();
    const seen = new Set<number>();
    for (let t = 0; t < 130; t += 0.05) {
      const loud = t % 1;
      stepDemo(d, 0.05, feed({ bass: loud, mid: 1 - loud, treble: 1, wave: [] }));
      for (const c of d.screen.colors) seen.add(c);
      seen.add(d.screen.border);
      seen.add(d.screen.background);
    }
    const bad = [...seen].filter((c) => VIC_PALETTE[c] === undefined);
    expect(bad, "colour indices with no VIC-II colour behind them").toEqual([]);
    // …and it does use the palette rather than sitting on two safe colours.
    expect(seen.size, "the demo barely touched the palette").toBeGreaterThan(8);
  });
});
