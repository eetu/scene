// Measure CPU/chipset THROUGHPUT of the currently-vendored core: emulated frames
// per wall-clock second under fast-forward (unthrottled). This is what the JIT
// accelerates — under normal (vsync) playback both cores hit the refresh cap and
// look identical; the JIT's win only shows when running flat-out.
//   node throughput.mjs [demo] [compat] [warmupSecs] [measureSecs]
// Reads whatever core is vendored in static/vendor/emulatorjs — swap stock vs JIT
// between runs to A/B. Prints steady-state emulated-fps + final JIT HUD stats.
import { spawn } from "node:child_process";
import { readdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = "/Users/eetu/dev/scene/emulators/puae-wasm/jit-runtime";
const DEMO =
  process.argv[2] ||
  "/Volumes/scene/parties/Assembly95/amiga/demo/01 - Parallax - ZIF/.support/ZIF (AGA).hdf";
const KICK = "/Volumes/scene/parties/.support/kick40068.A1200";
const COMPAT = process.argv[3] || "normal";
const WARMUP = Number(process.argv[4] || "12");
const MEASURE = Number(process.argv[5] || "20");
const DBG = 9493,
  PORT = 8895;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  const cache = join(process.env.HOME, "Library/Caches/ms-playwright");
  for (const d of await readdir(cache)) {
    if (!d.startsWith("chromium-")) continue;
    const p = join(
      cache,
      d,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    if (existsSync(p)) return p;
  }
  throw new Error("chrome not found");
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", (e) => rej(new Error("ws " + (e.message || e.type))));
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evals = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
      ?.result?.result?.value;
  return { ready, send, evals, close: () => ws.close() };
}
const getJson = (path) => fetch(`http://127.0.0.1:${DBG}${path}`).then((r) => r.json());
const hud = (c) =>
  c.evals("JSON.stringify(window.__hud||null)").then((s) => (s ? JSON.parse(s) : null));
// wall clock inside the page (host clock is fine too; use performance.now for precision)
const now = (c) => c.evals("performance.now()");

async function main() {
  const chrome = await findChrome();
  const profile = await mkdtemp(join(tmpdir(), "tp-"));
  const cr = spawn(
    chrome,
    [
      `--remote-debugging-port=${DBG}`,
      `--remote-allow-origins=*`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--ignore-gpu-blocklist",
      "--enable-gpu",
      "--use-angle=metal",
      "--enable-webgl",
      "--window-size=800,600",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  process.on("exit", () => {
    try {
      cr.kill("SIGKILL");
    } catch {}
  });
  const srv = spawn(
    "node",
    [join(HERE, "server.mjs"), "--port", String(PORT), "--isolate", "--demo", DEMO, "--kick", KICK],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  await sleep(1000);
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      wsUrl = (await getJson("/json")).find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl,
      )?.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(500);
  }
  const c = cdp(wsUrl);
  await c.ready;
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  const q = new URLSearchParams({
    cpu: "68020",
    compat: COMPAT,
    threads: "1",
    mode: "off",
    opts: JSON.stringify({ webgl2Enabled: "enabled" }),
  });
  await c.send("Page.navigate", { url: `http://localhost:${PORT}/?${q}` });

  // wait for boot
  let booted = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000 && !booted) {
    await sleep(1000);
    const h = await hud(c);
    if (h && h.frame > 0) booted = true;
  }
  if (!booted) {
    console.log("NO-BOOT");
    process.exit(2);
  }

  // fast-forward, warm up (let hot blocks compile + skip the loader), then measure
  await c.evals("window.__setFF&&window.__setFF(true,0)");
  await sleep(WARMUP * 1000);
  const h0 = await hud(c);
  const f0 = h0?.frame ?? 0,
    i0 = h0?.insnTotal ?? 0,
    w0 = await now(c);
  await sleep(MEASURE * 1000);
  const hEnd = await hud(c);
  const f1 = hEnd?.frame ?? 0,
    i1 = hEnd?.insnTotal ?? 0,
    w1 = await now(c);
  await c.evals("window.__setFF&&window.__setFF(false)");

  const wall = (w1 - w0) / 1000,
    dframes = f1 - f0,
    dinsn = i1 - i0;
  const fps = dframes / wall;
  const mips = dinsn / wall / 1e6;
  const viaJIT =
    hEnd?.insnTotal > 0 ? ((100 * (hEnd.insnJit || 0)) / hEnd.insnTotal).toFixed(1) : "0";
  console.log(
    JSON.stringify(
      {
        compat: COMPAT,
        warmupSecs: WARMUP,
        measureSecs: +wall.toFixed(1),
        framesEmulated: dframes,
        ffEmulatedFps: +fps.toFixed(1),
        insnMillions: +(dinsn / 1e6).toFixed(1),
        MIPS: +mips.toFixed(1),
        jitBlocks: hEnd?.jitStats?.activated ?? 0,
        viaJITpct: +viaJIT,
        smcHits: hEnd?.smcHits ?? 0,
      },
      null,
      2,
    ),
  );
  c.close();
  cr.kill("SIGKILL");
  try {
    srv.kill("SIGKILL");
  } catch {}
  process.exit(0);
}
main().catch((e) => (console.error(e), process.exit(1)));
