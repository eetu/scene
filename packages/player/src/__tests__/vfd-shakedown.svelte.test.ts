// A shakedown of @glowbox/vfd against the way this app actually uses it, run before the
// package is released. Not a regression suite for our code — it probes the library's
// edges: the claims its README makes, teardown, hostile drive values, live re-declaration
// of the hardware, and whether a consumer mistake degrades or takes the panel down.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { describe, expect, it, test } from "vitest";

import {
  CELL,
  cellGeometry,
  createVfdPanel,
  fallPeaks,
  layCells,
  segmentBits,
  segmentNames,
  type VfdElement,
  type VfdPanel,
} from "@glowbox/vfd";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function host(w = 640, h = 128): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px;display:block`;
  document.body.appendChild(c);
  return c;
}

/** A faceplate shaped like the one the hi-fi viz actually declares: every element kind,
 *  mixed phosphors, a printed row and a couple of filter zones. Probing the library with
 *  a single `digits` field would miss everything that only happens when unlike anodes
 *  share one envelope, which is the package's whole premise. */
function faceplate(): VfdElement[] {
  return [
    { kind: "digits", name: "main", chars: 10, glyphs: "14seg", x: 8, y: 10, w: 150, h: 30 },
    {
      kind: "digits",
      name: "count",
      chars: 4,
      glyphs: "7seg",
      align: "right",
      x: 8,
      y: 46,
      w: 40,
      h: 12,
    },
    { kind: "dots", name: "ticker", cols: 60, rows: 7, x: 60, y: 44, w: 96, h: 14 },
    {
      kind: "bars",
      name: "spec",
      bands: 12,
      rows: 8,
      peakHold: true,
      wedge: true,
      x: 170,
      y: 8,
      w: 100,
      h: 40,
    },
    { kind: "bars", name: "vu", bands: 2, rows: 10, from: "left", x: 170, y: 50, w: 100, h: 10 },
    { kind: "legend", name: "st", text: "ST", phosphor: "amber", x: 278, y: 8, w: 16, h: 7 },
    { kind: "legend", name: "rec", text: "REC", x: 278, y: 18, w: 20, h: 7 },
    { kind: "legend", name: "srcs", text: "TAPE", printed: true, x: 278, y: 28, w: 24, h: 7 },
    { kind: "icon", name: "play", d: "M300 40 L312 47 L300 54 Z", frame: [320, 64] },
    {
      kind: "icon",
      name: "reel",
      d: ["M8 4h30v20h-30z", "M18 10h10v8h-10z"],
      x: 240,
      y: 2,
      w: 20,
      h: 12,
    },
    {
      kind: "scale",
      name: "tune",
      ticks: 9,
      steps: 24,
      labels: [
        { at: 0, text: "88" },
        { at: 1, text: "108" },
      ],
      x: 8,
      y: 2,
      w: 150,
      h: 6,
    },
    { kind: "rule", name: "boxA", shape: "box", x: 166, y: 4, w: 108, h: 58 },
  ];
}

function panel(canvas: HTMLCanvasElement, extra: Record<string, unknown> = {}): VfdPanel {
  const p = createVfdPanel(canvas, {
    frame: [320, 64],
    layout: faceplate(),
    zones: [
      { x: 170, y: 50, w: 100, h: 10, filter: "amber" },
      { x: 276, y: 16, w: 24, h: 11, filter: "#c02010" },
    ],
    selfTest: false,
    label: "shakedown panel",
    ...extra,
  });
  expect(p, "createVfdPanel returned null").toBeTruthy();
  return p!;
}

/** Lit-pixel fraction of a snapshot, 0..1 — "is anything actually glowing". */
async function litness(p: VfdPanel): Promise<number> {
  const img = new Image();
  img.src = p.snapshot();
  await img.decode();
  const c = document.createElement("canvas");
  c.width = 120;
  c.height = 40;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.max(data[i], data[i + 1], data[i + 2]) > 90) n++;
  }
  return n / (data.length / 4);
}

/** Capture console.warn/error for the duration of `fn`. */
async function captureLogs(fn: () => Promise<void> | void) {
  const warns: string[] = [];
  const errors: string[] = [];
  const w = console.warn;
  const e = console.error;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = w;
    console.error = e;
  }
  return { warns, errors };
}

test("panel survives repeated create/dispose on one canvas", { timeout: 60000 }, async () => {
  const c = host();
  for (let i = 0; i < 20; i++) {
    const p = createVfdPanel(c, { frame: [320, 64], layout: faceplate(), selfTest: false });
    expect(p, `cycle ${i}: createVfdPanel returned null`).toBeTruthy();
    p!.set("main", `RUN ${i}`);
    p!.setBars("spec", [0.3, 0.9, 0.5, 1, 0.2, 0.7, 0.4, 0.8, 0.6, 0.1, 0.9, 0.3]);
    await sleep(10);
    p!.dispose();
  }
  // The family contract: dispose() hands the canvas back clean, so the same element has
  // to be reusable. An app that switches visualisers does exactly this.
  const again = createVfdPanel(c, { frame: [320, 64], layout: faceplate(), selfTest: false });
  expect(again, "canvas unusable after 20 dispose cycles").toBeTruthy();
  again!.dispose();
  c.remove();
});

test("set() accepts the number its own type allows", { timeout: 30000 }, async () => {
  const c = host();
  const p = panel(c);
  // `set(name, value: string | number)`. A tape counter is a number, and the scale
  // element takes one by definition — so a digits field being handed one is not a
  // consumer mistake, it is the signature.
  const { warns, errors } = await captureLogs(async () => {
    expect(() => p.set("count", 42), "set(digits, number) threw").not.toThrow();
    expect(() => p.set("tune", 0.42), "set(scale, number) threw").not.toThrow();
    expect(() => p.set("main", ""), "set(digits, '') threw").not.toThrow();
    await sleep(120);
  });
  expect(errors, `set() logged errors: ${errors.join(" | ")}`).toHaveLength(0);
  expect(
    warns.filter((s) => /count|tune/.test(s)),
    `set() warned on its own documented input: ${warns.join(" | ")}`,
  ).toHaveLength(0);
  p.set("count", 1234);
  await sleep(120);
  expect(await litness(p), "a numeric value lit nothing").toBeGreaterThan(0.002);
  p.dispose();
  c.remove();
});

test("blank() forgets a peak cap; writing zeros does not", { timeout: 30000 }, async () => {
  const c = host();
  const p = panel(c, { persistence: 0 });
  await sleep(80);
  const pristine = await litness(p);

  // Drive the analyser hard so every cap is parked at the top, then stop.
  for (let i = 0; i < 20; i++) {
    p.setBars("spec", new Array(12).fill(1));
    await sleep(16);
  }
  const loud = await litness(p);
  expect(loud, "driving the analyser lit nothing").toBeGreaterThan(pristine);

  // Zeros: the README says the caps remember, and a cap resting on the floor row is a
  // lit line for good. Wait well past peakFall (4 rows/s over 8 rows = 2s).
  p.setBars("spec", new Array(12).fill(0));
  await sleep(3500);
  const zeroed = await litness(p);

  p.clear("spec");
  await sleep(600);
  const blanked = await litness(p);

  // The claim under test: blank() is strictly darker than zeros, and lands back at
  // where the element had never been driven at all.
  expect(blanked, `blank() left as much lit as zeros (${blanked} vs ${zeroed})`).toBeLessThan(
    zeroed + 1e-6,
  );
  expect(
    Math.abs(blanked - pristine),
    `blank() did not return the element to its undriven state (pristine ${pristine}, blanked ${blanked})`,
  ).toBeLessThan(0.004);
  p.dispose();
  c.remove();
});

test(
  "driving through the wrong call warns rather than doing nothing silently",
  { timeout: 30000 },
  async () => {
    const c = host();
    const p = panel(c);
    const { warns } = await captureLogs(async () => {
      p.setBars("main", [1, 1, 1]); // bars on a digits field
      p.set("spec", "HELLO"); // text on an analyser
      p.setDots("vu", [1, 0, 1]); // a bitmap on a bar meter
      p.light("ticker", true); // a switch on a dot area
      await sleep(80);
    });
    // Four distinct mistakes, four distinct complaints — one swallowed is a mistake a
    // consumer never finds, which is the failure this contract exists to prevent.
    for (const [call, name] of [
      ["bars", "main"],
      ["set", "spec"],
      ["dots", "vu"],
      ["light", "ticker"],
    ]) {
      expect(
        warns.some((s) => s.includes(name)),
        `${call}() on the wrong kind ("${name}") warned nothing: ${warns.join(" | ")}`,
      ).toBe(true);
    }
    p.dispose();
    c.remove();
  },
);

test("an unknown element name warns once, not once a frame", { timeout: 30000 }, async () => {
  const c = host();
  const p = panel(c);
  const { warns } = await captureLogs(async () => {
    // A typo'd name inside a render loop is the realistic case, and "warns once" is the
    // documented behaviour — 300 lines of console is its own denial of service.
    for (let i = 0; i < 300; i++) p.set("nope", `${i}`);
    await sleep(80);
  });
  const hits = warns.filter((s) => s.includes("nope")).length;
  expect(hits, `unknown name warned ${hits} times over 300 calls`).toBeLessThanOrEqual(1);
  p.dispose();
  c.remove();
});

test(
  "hostile drive values degrade rather than poisoning an element",
  { timeout: 60000 },
  async () => {
    const c = host();
    const p = panel(c, { persistence: 0 });
    await sleep(60);

    const hostile: ArrayLike<number>[] = [
      [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN],
      new Array(12).fill(Infinity),
      new Array(12).fill(-Infinity),
      new Array(12).fill(-5),
      new Array(12).fill(1e12),
      [0.5], // short
      new Array(400).fill(0.5), // long
      [],
    ];
    for (const levels of hostile) {
      expect(
        () => p.setBars("spec", levels),
        `bars() threw on ${levels.length} hostile values`,
      ).not.toThrow();
      await sleep(20);
    }

    // The one that matters: after a NaN frame the element must still work. A peak cap
    // carried as NaN never compares true again, so that band would be dead for the life of
    // the panel — silently, and only for the bands that happened to see the NaN.
    p.setBars("spec", new Array(12).fill(0));
    await sleep(2600);
    const floor = await litness(p);
    for (let i = 0; i < 20; i++) {
      p.setBars("spec", new Array(12).fill(1));
      await sleep(16);
    }
    const recovered = await litness(p);
    expect(
      recovered,
      `the analyser did not light again after a NaN frame (${floor} → ${recovered})`,
    ).toBeGreaterThan(floor + 0.01);

    for (const value of ["", " ", "\u0000", "A".repeat(5000), "😀😀😀", "\n\t"]) {
      expect(
        () => p.set("main", value),
        `set() threw on ${JSON.stringify(value.slice(0, 12))}`,
      ).not.toThrow();
    }
    for (const v of [NaN, Infinity, -1, 1e9]) {
      expect(() => p.set("tune", v), `scale set() threw on ${v}`).not.toThrow();
    }
    await sleep(60);
    p.dispose();
    c.remove();
  },
);

test(
  "a dots bitmap function that throws does not take the panel down",
  { timeout: 30000 },
  async () => {
    const c = host();
    const p = panel(c);
    // A function bitmap is KEPT and sampled every frame, so an exception from it lands
    // inside the library's own render loop rather than in the caller's stack — which is
    // the difference between one bad element and a dead panel.
    //
    // 1.8.0-rc.1 survives it, which is the important half. But the exception is not caught
    // either: it escapes the rAF callback as an unhandled error the consumer has no way to
    // try/catch, once per frame for as long as the bad function is installed. In an app with
    // error reporting wired up that is a flood from a fault the panel has already absorbed.
    const escaped: string[] = [];
    const onError = (e: ErrorEvent) => void escaped.push(e.message);
    window.addEventListener("error", onError);

    let calls = 0;
    p.setDots("ticker", (x, y) => {
      calls++;
      if (x === 30 && y === 3) throw new Error("consumer bug");
      return (x + y) % 2;
    });
    await sleep(200);
    window.removeEventListener("error", onError);
    expect(calls, "the bitmap function was never sampled").toBeGreaterThan(0);
    expect(
      escaped.filter((m) => m.includes("consumer bug")),
      "the bitmap function's exception escaped the render loop uncaught",
    ).toHaveLength(0);

    // The rest of the panel has to keep running: drive something else and see it arrive.
    p.setDots("ticker", () => 0);
    p.setBars("spec", new Array(12).fill(0));
    await sleep(200);
    const dark = await litness(p);
    p.setBars("spec", new Array(12).fill(1));
    p.set("main", "STILL ALIVE");
    p.light("st", true);
    await sleep(300);
    const alive = await litness(p);
    expect(
      alive,
      `the render loop died after a bitmap function threw (${dark} → ${alive})`,
    ).toBeGreaterThan(dark + 0.01);
    p.dispose();
    c.remove();
  },
);

test(
  "re-declaring the hardware keeps drive state and does not re-run the self-test",
  { timeout: 60000 },
  async () => {
    const c = host();
    const p = createVfdPanel(c, { frame: [320, 64], layout: faceplate(), selfTest: true })!;
    // Let the power-on test finish before measuring anything.
    await sleep(1600);

    p.set("main", "KEEP ME");
    p.light("st", true);
    p.setBars("spec", new Array(12).fill(0.8));
    await sleep(200);
    const before = await litness(p);

    // The DISPLAY button: the analyser window becomes a graphic display. Same names for
    // what survives, a different job for the shared window.
    const swapped = faceplate().filter((e) => e.name !== "spec");
    swapped.push({
      kind: "dots",
      name: "graphic",
      cols: 40,
      rows: 8,
      x: 170,
      y: 8,
      w: 100,
      h: 40,
    });
    p.setLayout(swapped);
    // Immediately after: if setLayout re-runs the self-test, every anode is lit right now.
    await sleep(120);
    const justAfter = await litness(p);
    expect(
      justAfter,
      `setLayout re-ran the self-test — the whole panel lit up on a face change (${before} → ${justAfter})`,
    ).toBeLessThan(before + 0.25);

    p.setDots("graphic", (x, y) => ((x + y) % 4 === 0 ? 1 : 0));
    await sleep(200);
    // Drive state survives by name: "main" and "st" were never re-sent.
    const after = await litness(p);
    expect(after, "the panel went dark across setLayout").toBeGreaterThan(0.002);

    // And back again, repeatedly — a consumer flipping faces on a chip row.
    for (let i = 0; i < 12; i++) {
      p.setLayout(i % 2 ? faceplate() : swapped);
      p.set("main", `FACE ${i}`);
      await sleep(30);
    }
    expect(() => p.setLayout([]), "setLayout([]) threw").not.toThrow();
    await sleep(60);
    expect(
      () => p.setLayout(faceplate(), [640, 128]),
      "setLayout with a new frame threw",
    ).not.toThrow();
    await sleep(120);
    p.dispose();
    c.remove();
  },
);

test("driving it far faster than a multiplex could scan", { timeout: 60000 }, async () => {
  const c = host();
  const p = panel(c, { persistence: 0.4 });
  const levels = new Array(12).fill(0);
  // Every element re-driven every 5ms — harder than any real faceplate, and the case the
  // README's own bench calls out. It should degrade into smear, not throw or wedge.
  for (let i = 0; i < 250; i++) {
    for (let b = 0; b < 12; b++) levels[b] = Math.abs(Math.sin(i * 0.3 + b));
    p.setBars("spec", levels);
    p.setBars("vu", [Math.abs(Math.sin(i * 0.2)), Math.abs(Math.cos(i * 0.2))]);
    p.set("main", `FRAME ${i}`);
    p.set("count", `${i % 10000}`);
    p.set("tune", (i % 100) / 100);
    p.setDots("ticker", (x, y) => ((x + y + i) % 7 === 0 ? 1 : 0));
    p.light("st", i % 2 === 0);
    p.light("play", true);
    await sleep(5);
  }
  // Then settle: a panel that has been hammered still has to arrive somewhere definite.
  p.clear("spec");
  p.clear("vu");
  p.clear("ticker");
  p.set("main", "");
  p.light("st", false);
  p.light("play", false);
  await sleep(1200);
  const settled = await litness(p);
  p.set("main", "AWAKE");
  await sleep(400);
  expect(
    await litness(p),
    `panel unresponsive after a fast-drive burst (settled ${settled})`,
  ).toBeGreaterThan(settled);
  p.dispose();
  c.remove();
});

test(
  "geometry answers from where the anodes are, not from the declared box",
  { timeout: 30000 },
  async () => {
    const c = host(640, 128);
    const p = panel(c);
    await sleep(120);
    const r = c.getBoundingClientRect();

    // A framed icon declares the whole frame as its box. If hit-testing used that box it
    // would claim every tap on the panel — the exact case the README says `bounds` exists
    // to prevent.
    const hits = new Map<string, number>();
    for (let y = 2; y < r.height; y += 4) {
      for (let x = 2; x < r.width; x += 4) {
        const n = p.elementAt(r.left + x, r.top + y);
        if (n) hits.set(n, (hits.get(n) ?? 0) + 1);
      }
    }
    const total = [...hits.values()].reduce((a, b) => a + b, 0);
    const playShare = (hits.get("play") ?? 0) / Math.max(1, total);
    expect(
      playShare,
      `the framed "play" icon swallowed ${(playShare * 100) | 0}% of the panel`,
    ).toBeLessThan(0.2);
    // Silkscreen is skipped, so the box drawn around the analyser must not steal its taps.
    expect(hits.get("boxA"), "a rule element claimed pointer hits").toBeUndefined();
    expect(
      hits.get("spec"),
      "the analyser was unreachable under its own silkscreen box",
    ).toBeGreaterThan(0);
    // Printed legends are ink too.
    expect(hits.get("srcs"), "a printed legend claimed pointer hits").toBeUndefined();

    expect(p.elementAt(-1e6, -1e6), "a point far outside the canvas matched an element").toBeNull();
    expect(p.elementAt(NaN, NaN), "NaN coordinates matched an element").toBeNull();
    expect(p.elementRect("nope"), "elementRect of an unknown name was not null").toBeNull();
    const rect = p.elementRect("spec");
    expect(rect, "elementRect returned null for a real element").toBeTruthy();
    expect(rect!.width, "elementRect reported a zero-width box").toBeGreaterThan(0);
    // {left, top, width, height} — split-flap's cellRect spelling, which 1.9.0 brought this
    // handle into line with. Pinned because an {x, y} box would still typecheck as `unknown`
    // property access in plain JS and go silently wrong in whatever lays a control over it.
    expect(Object.keys(rect!).sort(), "elementRect changed shape").toEqual([
      "height",
      "left",
      "top",
      "width",
    ]);
    p.dispose();
    c.remove();
  },
);

test(
  "the envelope patches without re-compiling, however hard it is poked",
  { timeout: 60000 },
  async () => {
    const c = host();
    const p = panel(c);
    const patches: Parameters<VfdPanel["setOptions"]>[0][] = [
      { phosphor: "blue" },
      { phosphor: "amber" },
      { phosphor: "white" },
      { filter: "none" },
      { filter: "smoke" },
      { filter: "#20ff80" },
      { filter: [0.2, 1, 0.5] },
      { brightness: 0 },
      { brightness: 0.25 },
      { brightness: 1 },
      { brightness: -1 },
      { brightness: 99 },
      { persistence: 0 },
      { persistence: 1 },
      { persistence: NaN },
      { age: 0.65 }, // the vertical multiplex band
      { age: 0.85 }, // flicker
      { age: 1 }, // dead
      { age: 0 },
      { glow: 0 },
      { glow: 1 },
      { filament: false },
      { grid: false },
      { bezel: null },
      { bezel: "#404040" },
      { glass: "#000000" },
      { pixelRatio: 0 },
      { pixelRatio: 8 },
      { label: "" },
      { on: false },
      { on: true },
    ];
    const { errors } = await captureLogs(async () => {
      for (const patch of patches) {
        expect(
          () => p.setOptions(patch),
          `setOptions(${JSON.stringify(patch)}) threw`,
        ).not.toThrow();
        await sleep(24);
      }
    });
    expect(errors, `setOptions logged errors: ${errors.join(" | ")}`).toHaveLength(0);

    // Restore something sane and check the panel is still a panel.
    p.setOptions({ phosphor: "zn-o", filter: "green", brightness: 1, age: 0, on: true, glow: 0.7 });
    p.set("main", "RECOVERED");
    p.setBars("spec", new Array(12).fill(0.9));
    await sleep(400);
    expect(await litness(p), "the panel never came back from the option sweep").toBeGreaterThan(
      0.005,
    );
    p.dispose();
    c.remove();
  },
);

test("DISPLAY OFF and POWER OFF are dark but not blank", { timeout: 30000 }, async () => {
  const c = host();
  const p = panel(c, { filter: "none" }); // ghosts are only visible without a tint
  p.set("main", "LIT");
  p.setBars("spec", new Array(12).fill(1));
  p.light("st", true);
  await sleep(300);
  const lit = await litness(p);

  // Both of these are documented as NOT blanking: the undriven anodes and the silkscreen
  // are still sitting there behind the glass, exactly as on a switched-off stereo.
  p.setOptions({ brightness: 0 });
  await sleep(400);
  const dimmed = await litness(p);
  expect(dimmed, "the dimmer at 0 did not darken the panel").toBeLessThan(lit);

  p.setOptions({ brightness: 1 });
  p.power(false);
  await sleep(400);
  const off = await litness(p);
  expect(off, "power(false) did not darken the panel").toBeLessThan(lit);

  p.power(true);
  await sleep(1600); // power-on re-runs the self-test if the panel was built with one
  expect(await litness(p), "power(true) did not bring the panel back").toBeGreaterThan(off);
  p.dispose();
  c.remove();
});

test("degenerate geometry is survivable", { timeout: 30000 }, async () => {
  // A viz pane is laid out asynchronously, so a panel can genuinely be created against a
  // zero-sized canvas and resized a frame later. That must not be fatal or permanent.
  const c = host(0, 0);
  const p = createVfdPanel(c, { frame: [320, 64], layout: faceplate(), selfTest: false });
  expect(p, "createVfdPanel returned null for a zero-sized canvas").toBeTruthy();
  p!.set("main", "ZERO");
  p!.setBars("spec", new Array(12).fill(0.5));
  await sleep(120);
  c.style.width = "640px";
  c.style.height = "128px";
  p!.resize();
  await sleep(300);
  expect(await litness(p!), "the panel never recovered from a zero-sized start").toBeGreaterThan(
    0.002,
  );
  p!.dispose();
  c.remove();

  // A degenerate design frame is a consumer mistake, and what matters is HOW it fails.
  //
  // rc.1 threw `InvalidStateError: Failed to execute 'drawImage' … width or height of 0`
  // out of the canvas — the offscreen the glow pass composites through is sized from the
  // frame — and then kept throwing it once a frame from inside the render loop, as an
  // unhandled error no consumer could catch.
  //
  // rc.2 rejects it at construction with the library's own named error instead. That is the
  // better contract, not merely a different one: a zero frame is a programming mistake, a
  // loud complaint at the call site is where a mistake belongs, and nothing is left running
  // to complain again. So this pins the SHAPE of the failure rather than demanding silence.
  const c2 = host();
  let thrown: unknown;
  const before: string[] = [];
  const onError = (e: ErrorEvent) => void before.push(e.message);
  window.addEventListener("error", onError);
  try {
    createVfdPanel(c2, { frame: [0, 0], layout: faceplate(), selfTest: false });
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "a [0,0] frame was accepted silently").toBeInstanceOf(Error);
  expect(
    String((thrown as Error).message),
    "the complaint is not one of the library's own",
  ).toMatch(/glowbox/i);
  // And nothing is left running to throw again where it cannot be caught.
  await sleep(300);
  window.removeEventListener("error", onError);
  expect(before, `a rejected panel kept throwing: ${before.join(" | ")}`).toHaveLength(0);
  c2.remove();
});

// This app already runs an AudioContext for playback and browsers cap how many a page may
// have. The README says this core has no sound module at all — pin that, so it can't
// quietly acquire one the way flip-dot's did.
test("the panel opens no AudioContext", { timeout: 30000 }, async () => {
  const c = host();
  const Real = window.AudioContext;
  let built = 0;
  class Counting extends Real {
    constructor(...args: ConstructorParameters<typeof Real>) {
      super(...args);
      built++;
    }
  }
  (window as unknown as { AudioContext: typeof Real }).AudioContext =
    Counting as unknown as typeof Real;
  try {
    const p = createVfdPanel(c, { frame: [320, 64], layout: faceplate(), selfTest: true })!;
    await sleep(200);
    p.set("main", "QUIET");
    p.setBars("spec", new Array(12).fill(1));
    p.selfTest();
    await sleep(400);
    p.dispose();
    await sleep(50);
    expect(built, `the panel opened ${built} AudioContext(s)`).toBe(0);
  } finally {
    (window as unknown as { AudioContext: typeof Real }).AudioContext = Real;
  }
  c.remove();
});

test("a settled panel stops rendering", { timeout: 30000 }, async () => {
  // "The loop runs only while something is in flight, so a settled panel is free" — the
  // README's own cost claim, and the reason this viz can leave a faceplate up beside a 2D
  // chassis that animates on its own budget.
  //
  // Counted at the CANVAS, not by patching window.requestAnimationFrame: the panel does
  // not go through the global at call time, so a patched rAF counts zero whether the loop
  // is running or not — which reads exactly like a pass. Wrapping a draw call the
  // renderer must make every frame cannot be fooled that way.
  const c = host();
  const ctx = c.getContext("2d")!;
  let draws = 0;
  const realClear = ctx.clearRect.bind(ctx);
  ctx.clearRect = ((...a: Parameters<typeof realClear>) => {
    draws++;
    return realClear(...a);
  }) as typeof ctx.clearRect;
  const realFill = ctx.fillRect.bind(ctx);
  ctx.fillRect = ((...a: Parameters<typeof realFill>) => {
    draws++;
    return realFill(...a);
  }) as typeof ctx.fillRect;

  const p = panel(c, { persistence: 0 });
  p.set("main", "SETTLED");
  await sleep(1500);

  draws = 0;
  await sleep(500); // ~30 frames at 60Hz if the loop never stops
  const idle = draws;
  p.setBars("spec", new Array(12).fill(1));
  await sleep(300);
  expect(draws, "driving a settled panel did not restart its loop").toBeGreaterThan(idle);
  expect(
    idle,
    `a settled panel kept rendering (${idle} draw calls in 500ms of nothing)`,
  ).toBeLessThan(8);
  p.dispose();
  c.remove();
});

// ─── the claims the README makes ───────────────────────────────────────────────────────
//
// Pure assertions, kept in this suite rather than in the unit run because they are the
// package's promises rather than ours: a failure here is a bug to fix upstream, not a
// build to break.

describe("the decimal point takes no cell", () => {
  it("lays the point onto the cell before it", () => {
    const cells = layCells("FM 98.50", 8, "left", true);
    expect(cells.map((c) => c.ch).join("")).toBe("FM 9850 ");
    expect(cells[4].dp, "the point did not attach to the 8").toBe(true);
  });

  it("does the same for a clock colon", () => {
    const cells = layCells("12:34", 5, "left", true);
    expect(cells[1].colon).toBe(true);
    expect(cells.map((c) => c.ch).join("")).toBe("1234 ");
  });

  it("clamps a nonsense width the way compilePanel does", () => {
    // compilePanel takes `chars: -4` and quietly gives you one cell. layCells throws a raw
    // `RangeError: Invalid array length` out of an Array constructor for the same input —
    // two halves of one concept disagreeing, and the error that escapes is not one of the
    // library's own.
    expect(
      () => layCells("AB", -4, "left", true),
      "layCells threw on a negative width",
    ).not.toThrow();
    expect(layCells("AB", 0, "left", true)).toHaveLength(0);
  });

  // …and then it has to actually be DRAWN. Both do light, and the point lands where a
  // point goes; see the placement test below for the one that doesn't.
  it("actually lights the point and the colon", async () => {
    const c = host(600, 120);
    const p = createVfdPanel(c, {
      frame: [120, 40],
      layout: [{ kind: "digits", name: "d", chars: 6, glyphs: "7seg", x: 4, y: 4, w: 112, h: 32 }],
      // No tint, no mesh, no glow spread: this is a pixel count, and all three exist to
      // make the panel look like hardware rather than to make it measurable.
      filter: "none",
      grid: false,
      filament: false,
      persistence: 0,
      selfTest: false,
    })!;
    expect(p).toBeTruthy();

    p.set("d", "888888");
    await sleep(250);
    const plain = await litness(p);
    p.set("d", "88.8888");
    await sleep(250);
    const withDp = await litness(p);
    p.set("d", "88:8888");
    await sleep(250);
    const withColon = await litness(p);

    expect(
      withDp,
      `'88.8888' lit no more anodes than '888888' (${plain} vs ${withDp})`,
    ).toBeGreaterThan(plain);
    expect(
      withColon,
      `'88:8888' lit no more anodes than '888888' (${plain} vs ${withColon})`,
    ).toBeGreaterThan(plain);
    p.dispose();
    c.remove();
  });

  it("puts the colon in the gap, not on top of the digit", () => {
    // The point sits at x 50..56 of a 60-wide cell — the trailing corner, which is empty on
    // every glyph, so it reads as a point after the digit. 1.8.0-rc.1 puts the two colon
    // beads at x 24..30: the horizontal CENTRE of the cell, directly on top of the glyph's
    // own segments. '12:34' therefore renders as four digits with two dots buried inside
    // the 2, instead of as a time — which is the one thing a colon exists to do. The beads
    // want the trailing gap, at the point's x, one above and one below the middle bar.
    const geo = cellGeometry("7seg");
    const xs = (poly: number[]) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < poly.length; i += 2) {
        lo = Math.min(lo, poly[i]);
        hi = Math.max(hi, poly[i]);
      }
      return { lo, hi };
    };
    const dp = xs(geo[geo.length - 3]);
    const c1 = xs(geo[geo.length - 2]);
    const c2 = xs(geo[geo.length - 1]);
    // The point is the reference: whatever x the library considers "after the glyph", the
    // colon beads belong at the same one.
    expect(dp.lo, `the point is at x ${dp.lo}..${dp.hi} of ${CELL.width}`).toBeGreaterThan(
      CELL.width * 0.7,
    );
    expect(c1.lo, `colon bead 1 is at x ${c1.lo}..${c1.hi}`).toBeGreaterThan(CELL.width * 0.7);
    expect(c2.lo, `colon bead 2 is at x ${c2.lo}..${c2.hi}`).toBeGreaterThan(CELL.width * 0.7);
  });
});

describe("the segment repertoire", () => {
  it("draws a V that reaches the bottom and is not a Y", async () => {
    // A SYMMETRIC V is impossible on this lattice, and that is the whole point of this test.
    //
    // Compiling `cellGeometry('14seg')` and reading which junctions each segment joins gives:
    //
    //     h  TL <-> MC        k  MC <-> BL         (TL/TR/BL/BR = corners,
    //     j  TR <-> MC        m  MC <-> BR          MC = middle centre, BC = bottom centre)
    //
    // Every diagonal runs corner ↔ MIDDLE-CENTRE. The only edges touching bottom-centre are
    // d1, d2 and `l` — so the one route from a top corner down to BC is via MC and then the
    // `l` stem, and two arms taking it must SHARE that stem. Sharing the stem is what a Y is.
    // There is no pair of strokes meeting at the bottom centre.
    //
    // So the achievable Vs are: `h j` (symmetric but half-height, floating in the top half),
    // `h j l` (a Y), or `e f j k` (full height, the arms meeting at the bottom LEFT — the
    // conventional 16-segment V, and the right one). Asserted here: the letter must reach
    // the bottom, and it must not be a Y.
    //
    // Two cells, "UV", and the canvas matched to the frame's aspect so the plate is not
    // letterboxed inside it. U is the reference: it is unambiguous, uses the full cell, and
    // gives a height to measure V against — a V measured only against ITSELF is full-height
    // by definition.
    const c = host(600, 500);
    const p = createVfdPanel(c, {
      frame: [120, 100],
      layout: [
        {
          kind: "digits",
          name: "d",
          chars: 2,
          glyphs: "14seg",
          slant: false,
          x: 6,
          y: 6,
          w: 108,
          h: 88,
        },
      ],
      filter: "none",
      grid: false,
      filament: false,
      glow: 0,
      persistence: 0,
      selfTest: false,
    })!;
    expect(p).toBeTruthy();
    p.set("d", "UV");
    await sleep(250);

    const img = new Image();
    img.src = p.snapshot();
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = 120;
    cv.height = 100;
    const g = cv.getContext("2d")!;
    g.drawImage(img, 0, 0, cv.width, cv.height);
    const { data } = g.getImageData(0, 0, cv.width, cv.height);
    const lit = (x: number, y: number) => {
      const i = (y * cv.width + x) * 4;
      return Math.max(data[i], data[i + 1], data[i + 2]) > 70;
    };

    // Each glyph's OWN bounds, found rather than assumed: a cell is fitted inside its element
    // box preserving the face's aspect and then inset by the tracking, so the ink sits well
    // inside the canvas rather than filling it.
    const bounds = (cx0: number, cx1: number) => {
      let x0 = 1e9;
      let y0 = 1e9;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < cv.height; y++) {
        for (let x = cx0; x < cx1; x++) {
          if (!lit(x, y)) continue;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
      return { x0, y0, w: x1 - x0, h: y1 - y0 };
    };
    const u = bounds(0, 60);
    const v = bounds(60, 120);
    expect(v.w, "the V drew nothing at all").toBeGreaterThan(0);

    // Full height, measured against the U beside it. rc.1's V was a symmetric chevron in the
    // upper half of the cell — right shape, half the letter.
    expect(v.h / u.h, `V is ${((v.h / u.h) * 100) | 0}% of U's height`).toBeGreaterThan(0.85);

    const anyIn = (fx0: number, fx1: number, fy0: number, fy1: number) => {
      for (let y = Math.round(v.y0 + fy0 * v.h); y <= Math.round(v.y0 + fy1 * v.h); y++) {
        for (let x = Math.round(v.x0 + fx0 * v.w); x <= Math.round(v.x0 + fx1 * v.w); x++) {
          if (lit(x, y)) return true;
        }
      }
      return false;
    };
    // Both arms start at the top.
    expect(anyIn(0, 0.35, 0, 0.25), "no left arm at the top").toBe(true);
    expect(anyIn(0.65, 1, 0, 0.25), "no right arm at the top").toBe(true);

    // Two separate strokes below the mid-line, where a Y has only its stem. Sampled at 65%
    // rather than at the waist: the segments break AT the mid-line — the upper group ends at
    // y 49 of the cell and the lower group starts at 52 — so a row sampled there crosses the
    // gap and finds nothing at all, whatever the letter.
    let runs = 0;
    let wasLit = false;
    const band = Math.round(v.y0 + v.h * 0.65);
    for (let x = 60; x < cv.width; x++) {
      const on = lit(x, band);
      if (on && !wasLit) runs++;
      wasLit = on;
    }
    expect(runs, `V has ${runs} stroke(s) below its waist — a Y would have one`).toBe(2);

    p.dispose();
    c.remove();
  });

  it("gives every letter its own segments", () => {
    // No two letters may light the same anodes. Cheap, and it guards a whole class: rc.3's V
    // landed one segment away from Y, and a mask that drifts one further is a letter the
    // panel can no longer spell.
    //
    // Deliberately NOT a proxy for "V looks wrong" — rc.3's V and Y differ by two bits and
    // pass this, while both still draw a Y. Bit counts say nothing about shape; the test
    // above asserts the actual segments a V is made of.
    const seen = new Map<number, string>();
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const bits = segmentBits("14seg", ch);
      const clash = seen.get(bits);
      expect(clash, `${ch} and ${clash} light the same segments`).toBeUndefined();
      seen.set(bits, ch);
    }
  });

  it("draws X, W and Y as they always were", () => {
    const names = segmentNames("14seg");
    const litOf = (ch: string) => {
      const b = segmentBits("14seg", ch);
      return names.filter((_, i) => (b >> i) & 1);
    };
    expect(litOf("X").sort()).toEqual(["h", "j", "k", "m"]);
    expect(litOf("W")).toContain("k");
    expect(litOf("W")).toContain("m");
    expect(litOf("Y")).toContain("l");
  });
});

describe("peak caps", () => {
  it("does not conjure a cap for a band nobody drove", () => {
    const peaks = [-1, -1, -1];
    for (let i = 0; i < 100; i++) fallPeaks(peaks, [0, 0, 0], 8, 4, 0.016);
    expect(peaks).toEqual([-1, -1, -1]);
  });

  it("falls at the rate it was given", () => {
    const peaks = [-1];
    fallPeaks(peaks, [1], 8, 4, 0.016);
    expect(peaks[0]).toBeCloseTo(8, 1);
    for (let i = 0; i < 62; i++) fallPeaks(peaks, [0], 8, 4, 1 / 62);
    expect(peaks[0]).toBeGreaterThan(3.4);
    expect(peaks[0]).toBeLessThan(4.6);
  });

  it("does not let a NaN level kill a band for good", () => {
    // 1.8.0-rc.1: one NaN goes straight into the cap, and NaN never compares true again —
    // so that band is dead for the life of the element, silently, and only for whichever
    // bands happened to see it. A band mapping that averages an empty bin range produces
    // one of these without trying.
    const peaks = [-1];
    fallPeaks(peaks, [NaN], 8, 4, 0.016);
    expect(Number.isNaN(peaks[0]), "a NaN level was written straight into the cap").toBe(false);
    fallPeaks(peaks, [1], 8, 4, 0.016);
    expect(peaks[0], "the band never recovered from a NaN frame").toBeCloseTo(8, 1);
  });

  it("does not let a backwards clock inflate a cap above the element", () => {
    // 1.8.0-rc.1: a negative dt makes caps RISE — 4 rows becomes 44 after one dt of -10.
    // A cap parked above the top row is a lit line that can never come down.
    const peaks = [-1];
    fallPeaks(peaks, [0.5], 8, 4, 0.016);
    fallPeaks(peaks, [0], 8, 4, -10);
    expect(peaks[0], `cap climbed to ${peaks[0]} on a negative dt`).toBeLessThanOrEqual(8);
  });
});
