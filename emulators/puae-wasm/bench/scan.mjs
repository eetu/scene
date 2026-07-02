// Scan a folder of Amiga demos for one that ANIMATES CONTINUOUSLY from early on
// (ZIF is static-title → short burst → static, which is awkward to benchmark).
// For each demo: boot, then sample effective/vblank fps for a window; report
// time-to-first-animation, how much of the window is animating, the sustained
// effective fps, and the worst vblank dip (how far below realtime the host falls
// under load). Pick a demo with early + high animFrac for a stable baseline.
//
//   node scan.mjs [--dir "/Volumes/scene/parties/Assembly95/amiga/demo"] [--sample 25]
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
const DIR = arg("dir", "/Volumes/scene/parties/Assembly95/amiga/demo");
const KICK = arg("kick", "/Volumes/scene/parties/.support/kick40068.A1200");
const SAMPLE = Number(arg("sample", "25")) * 1000;
const ANIM = 8; // effectiveFps ≥ this ⇒ "animating"
const DBG = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  const cache = join(process.env.HOME, "Library/Caches/ms-playwright");
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
  throw new Error("chrome not found");
}

// Find each demo's bootable disk image: <dir>/<entry>/.support/*.{adf,hdf}
async function discover(dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const sup = join(dir, entry.name, ".support");
    if (!existsSync(sup)) continue;
    const disk = (await readdir(sup)).find((f) => !f.startsWith("._") && /\.(adf|hdf)$/i.test(f));
    if (disk) out.push({ name: entry.name, path: join(sup, disk) });
  }
  return out;
}

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
    ws.addEventListener("error", (e) => rej(e));
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
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

async function scanOne(c, demo, port) {
  const srv = spawn(
    "node",
    [join(HERE, "server.mjs"), "--demo", demo.path, "--kick", KICK, "--port", String(port)],
    {
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  await sleep(400);
  try {
    await c.send("Page.navigate", { url: `http://localhost:${port}/?cpu=68030&compat=normal` });
    let booted = false;
    for (let i = 0; i < 80; i++) {
      const f = await c.evals("(window.__bench&&window.__bench.frame)||0");
      if (f > 0) {
        booted = true;
        break;
      }
      await sleep(500);
    }
    if (!booted) return { ...demo, error: "no boot" };

    const eff = [],
      vbl = [];
    let tFirstAnim = null;
    const t0 = Date.now();
    while (Date.now() - t0 < SAMPLE) {
      await sleep(1000);
      const b = await c.bench();
      if (!b) continue;
      eff.push(b.effectiveFps);
      vbl.push(b.vblankFps);
      if (tFirstAnim === null && b.effectiveFps >= ANIM)
        tFirstAnim = +((Date.now() - t0) / 1000).toFixed(0);
    }
    const animSamples = eff.filter((e) => e >= ANIM);
    return {
      ...demo,
      tFirstAnim,
      animFrac: +(animSamples.length / (eff.length || 1)).toFixed(2),
      effWhenAnim: +median(animSamples).toFixed(1),
      effMax: +Math.max(0, ...eff).toFixed(1),
      vblankMin: +Math.min(99, ...vbl).toFixed(1),
      vblankMedian: +median(vbl).toFixed(1),
    };
  } finally {
    try {
      srv.kill("SIGKILL");
    } catch {}
  }
}

async function main() {
  const chrome = await findChrome();
  const demos = await discover(DIR);
  console.log(`scanning ${demos.length} demos in ${DIR}\n`);

  const profile = await mkdtemp(join(tmpdir(), "puae-scan-"));
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
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const cleanup = () => {
    try {
      cr.kill("SIGKILL");
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
    cleanup();
    throw new Error("no page target");
  }
  const c = cdp(wsUrl);
  await c.ready;
  await c.send("Page.enable");
  await c.send("Runtime.enable");

  const results = [];
  let port = 8810;
  for (const demo of demos) {
    process.stdout.write(`• ${demo.name.padEnd(40)} `);
    const r = await scanOne(c, demo, port++);
    results.push(r);
    if (r.error) console.log(r.error);
    else
      console.log(
        `anim@${r.tFirstAnim ?? "—"}s frac ${r.animFrac} eff ${r.effWhenAnim} (max ${r.effMax}) vblankMin ${r.vblankMin}`,
      );
  }
  c.close();
  cleanup();

  console.log("\n=== best continuous animators (high animFrac, early, low vblankMin) ===");
  results
    .filter((r) => !r.error)
    .sort((a, b) => b.animFrac - a.animFrac || (a.tFirstAnim ?? 99) - (b.tFirstAnim ?? 99))
    .slice(0, 6)
    .forEach((r) =>
      console.log(
        `${r.name.padEnd(40)} animFrac ${r.animFrac}  first@${r.tFirstAnim ?? "—"}s  ` +
          `effWhenAnim ${r.effWhenAnim}  vblankMin ${r.vblankMin}  vblankMed ${r.vblankMedian}`,
      ),
    );
  console.log("\nPick one with animFrac≈1 (animates throughout) and a low vblankMin");
  console.log("(vblankMin well under 50 = the host-bound lag a JIT must fix).");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
