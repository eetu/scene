// Headless baseline + CPU-model A/B for the puae-wasm bench.
//
// Boots server.mjs + a cached chrome-headless-shell (driven over the DevTools
// Protocol — no npm deps), then for each CPU variant: loads the harness, waits
// past the Kickstart HD boot AND the demo's static intro until the animation
// actually starts (the canvas begins changing), then samples for a window.
//
// Reports TWO numbers per variant (see index.html): effectiveFps (the REAL lag
// metric — distinct rendered frames/sec) and vblankFps (~50 while the host keeps
// realtime). This directly tests the fs-uae finding — does raising the emulated
// CPU model (020→030→040) cure the lag WITHOUT the host falling behind? If so,
// no JIT is needed; it's a config fix.
//
//   node measure.mjs [--warmup 3] [--measure 12] [--demo <path>] [--kick <path>]
import { spawn } from "node:child_process";
import { readdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const WARMUP = Number(arg("warmup", "3")) * 1000; // extra settle after animation starts
const MEASURE = Number(arg("measure", "12")) * 1000;
const FF = Number(arg("ff", "0")); // fast-forward past this many emulated seconds of intro
const FFRATIO = Number(arg("ffratio", "0")); // 0 = unlimited
const NOANIM = process.argv.includes("--noanim"); // skip waitAnimation; sample immediately
const PORT = Number(arg("port", "8790"));
const DBG = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Baseline = the party app's real accelerated config (030/normal). We already
// know from testing that raising the CPU model doesn't help in WASM (no JIT —
// the interpreter can't deliver the MIPS), so this run's job is to QUANTIFY the
// lag: the effectiveFps a 68k→WASM recompiler must beat. `--matrix` still runs
// the full CPU sweep for the record.
const BASELINE = [{ label: "030 normal (app default)", q: "cpu=68030&compat=normal" }];
const MATRIX = [
  { label: "020 cycle-exact (stock A1200)", q: "cpu=68020&compat=exact&ce=1" },
  { label: "020 normal", q: "cpu=68020&compat=normal" },
  { label: "030 normal (app default)", q: "cpu=68030&compat=normal" },
  { label: "040 normal", q: "cpu=68040&compat=normal" },
];
const VARIANTS = process.argv.includes("--matrix") ? MATRIX : BASELINE;

async function findChrome() {
  const explicit = arg("chrome", "");
  if (explicit) return explicit;
  const cache = join(process.env.HOME, "Library/Caches/ms-playwright");
  if (!existsSync(cache)) throw new Error("no ms-playwright cache; pass --chrome <path>");
  for (const d of await readdir(cache)) {
    if (!d.startsWith("chromium")) continue;
    for (const sub of [
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ]) {
      const p = join(cache, d, sub);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("chrome-headless-shell not found in cache; pass --chrome <path>");
}

// Minimal CDP client over one page-target WebSocket.
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", (e) => rej(new Error("ws error: " + (e.message || e.type))));
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evals = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.result?.value;
  };
  const bench = async () => {
    const s = await evals("JSON.stringify(window.__bench||null)");
    return s ? JSON.parse(s) : null;
  };
  return { ready, send, evals, bench, close: () => ws.close() };
}

const getJson = (path) => fetch(`http://127.0.0.1:${DBG}${path}`).then((r) => r.json());

async function pollUntil(c, expr, ms, every = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await c.evals(expr)) return true;
    } catch {}
    await sleep(every);
  }
  return false;
}

// Wait until the canvas is actually animating (past the static intro): the
// distinct-frame counter must climb over a 1.5s window.
async function waitAnimation(c, ms) {
  const t0 = Date.now();
  let prev = (await c.bench())?.distinct ?? 0;
  while (Date.now() - t0 < ms) {
    await sleep(1500);
    const b = await c.bench();
    const now = b?.distinct ?? 0;
    if (now - prev >= 8) return true; // ~5+ distinct fps → animating
    prev = now;
  }
  return false;
}

async function runVariant(c, base, v) {
  console.log(`\n── ${v.label}  [${v.q}] ──`);
  await c.send("Page.navigate", { url: `${base}?${v.q}` });
  if (!(await pollUntil(c, "window.crossOriginIsolated?1:0", 20000)))
    console.log("  (warning: not crossOriginIsolated — threads off)");
  if (!(await pollUntil(c, "(window.__bench&&window.__bench.frame>0)?1:0", 45000))) {
    console.log("  never produced a frame — skipping");
    return null;
  }
  const b0 = await c.bench();
  if (b0 && !b0.hashOk) console.log("  (warning: canvas unreadable — effectiveFps invalid)");

  if (FF > 0) {
    console.log(`  fast-forwarding past ${FF}s of intro (ratio ${FFRATIO || "unlimited"})…`);
    await c.evals(`window.__setFF(true, ${FFRATIO})`);
    await pollUntil(c, `(window.__bench&&window.__bench.frame>=${FF * 50})?1:0`, 60000);
    await c.evals("window.__setFF(false)"); // back to 1× to measure the true lag
    await sleep(500);
  }

  if (NOANIM) {
    console.log("  sampling continuous trace (no animation gate)…");
  } else {
    console.log("  booted; waiting for animation to start…");
    const animated = await waitAnimation(c, 45000);
    if (!animated) console.log("  (animation never detected; measuring anyway)");
  }
  await sleep(WARMUP);

  const eff = [];
  const vbl = [];
  const t0 = Date.now();
  while (Date.now() - t0 < MEASURE) {
    await sleep(1000);
    const b = await c.bench();
    if (!b) continue;
    eff.push(b.effectiveFps);
    vbl.push(b.vblankFps);
    process.stdout.write(
      `  t+${b.elapsed}s  effective ${b.effectiveFps}fps  vblank ${b.vblankFps}  frame ${b.frame}  threads:${b.threads}\n`,
    );
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  return {
    label: v.label,
    effectiveFpsMedian: +median(eff).toFixed(1),
    effectiveFpsMean: +mean(eff).toFixed(1),
    vblankFpsMean: +mean(vbl).toFixed(1),
    samples: eff.length,
  };
}

async function main() {
  const chrome = await findChrome();
  console.log(`chrome: ${chrome}`);

  const passthrough = [];
  for (const k of ["demo", "kick", "target", "vendor"]) {
    const val = arg(k, "");
    if (val) passthrough.push(`--${k}`, val);
  }
  const srv = spawn("node", [join(HERE, "server.mjs"), "--port", String(PORT), ...passthrough], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  await sleep(500);

  const profile = await mkdtemp(join(tmpdir(), "puae-bench-"));
  const cr = spawn(
    chrome,
    [
      `--remote-debugging-port=${DBG}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--window-size=800,600",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let crlog = "";
  cr.stderr.on("data", (d) => (crlog += d));
  const cleanup = () => {
    try {
      cr.kill("SIGKILL");
    } catch {}
    try {
      srv.kill("SIGKILL");
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await getJson("/json")).find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl,
      );
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!wsUrl) {
    console.error(crlog.slice(-800));
    cleanup();
    throw new Error("no chrome page target");
  }

  const c = cdp(wsUrl);
  await c.ready;
  await c.send("Page.enable");
  await c.send("Runtime.enable");

  const base = `http://localhost:${PORT}/`;
  const results = [];
  for (const v of VARIANTS) {
    const r = await runVariant(c, base, v);
    if (r) results.push(r);
  }
  c.close();
  cleanup();

  if (!results.length) {
    console.error("\nNO RESULTS. Chrome stderr tail:\n" + crlog.slice(-1200));
    process.exit(2);
  }
  console.log("\n=== A/B RESULTS (target 50 fps PAL) ===");
  console.log("effectiveFps = real lag metric · vblankFps ≈50 means host keeps realtime\n");
  for (const r of results) {
    console.log(
      `${r.label.padEnd(32)} effective ${String(r.effectiveFpsMedian).padStart(5)} fps ` +
        `(mean ${r.effectiveFpsMean})   vblank ${r.vblankFpsMean}`,
    );
  }
  console.log("\nReading: if effectiveFps rises with CPU model while vblank stays ~50 →");
  console.log("guest-CPU-bound, curable by config (no JIT). If vblank drops → host-bound.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
