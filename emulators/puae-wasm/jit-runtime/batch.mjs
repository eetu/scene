// Batch launch-checker: boot every Amiga disk image under a party dir headless
// (on the JIT core), fast-forward past the load, and measure whether it mounts
// and runs — to surface stragglers that were imaged/config'd wrong and never
// start (bad/corrupt HDF, won't mount, immediate guru/halt).
//
//   node batch.mjs --dir "/Volumes/scene/parties/Assembly95/amiga" [--out <dir>]
//                  [--ff 15] [--window 8] [--boot 45]
// Reads the JIT core from the party's vendored dir by default. Threaded (HDF+ADF).
//
// SIGNAL: headless swiftshader freezes the GL canvas (screenshots are black even
// for a perfectly-running demo), so this is a BOOT+RUN health check, not a visual
// one. Verdict is driven by vblankFps (the emulated frame rate):
//   OK       booted and sustained a healthy vblank (mounted + running at speed)
//   SUSPECT  booted but never reached a healthy rate (stuck/struggling/crashed)
//   NO-BOOT  no emulated frame ever advanced (image didn't come up at all)
// Caveat: a demo that boots into a disk-requester or workbench still runs Kickstart
// at full vblank, so it reads OK here — this catches hard failures, not wrong art.
import { spawn } from "node:child_process";
import { readdir, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DIR = arg("dir", "/Volumes/scene/parties/Assembly95/amiga");
const OUT = arg("out", "/Users/eetu/Desktop/jit-shots/batch");
const KICK = arg("kick", "/Volumes/scene/parties/.support/kick40068.A1200");
const FF = Number(arg("ff", "15"));
const WINDOW = Number(arg("window", "8")) * 1000;
const BOOT = Number(arg("boot", "45")) * 1000;
const DBG = 9400;
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
  throw new Error("chrome-headless-shell not found");
}

// recursively collect *(AGA|A500|OCS|ECS).(adf|hdf) images, skipping macOS junk
async function collect(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith("._") || e.name === ".DS_Store") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await collect(p, out);
    else if (/\((?:AGA|A500|OCS|ECS)\)[^/]*\.(adf|hdf)$/i.test(e.name)) out.push(p);
  }
  return out;
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
  const evals = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.result?.value;
  };
  return { ready, send, evals, close: () => ws.close() };
}
const getJson = (path) => fetch(`http://127.0.0.1:${DBG}${path}`).then((r) => r.json());
const hud = (c) =>
  c.evals("JSON.stringify(window.__hud||null)").then((s) => (s ? JSON.parse(s) : null));

async function main() {
  const chrome = await findChrome();
  await mkdir(OUT, { recursive: true });
  const images = (await collect(DIR)).sort();
  console.log(`chrome: ${chrome}\n${images.length} images under ${DIR}\nout: ${OUT}\n`);

  const profile = await mkdtemp(join(tmpdir(), "puae-batch-"));
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
  process.on("SIGINT", () => (cleanup(), process.exit(1)));

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

  const results = [];
  let port = 8860;
  for (const img of images) {
    port++;
    const label = basename(img).replace(/\.(adf|hdf)$/i, "");
    const srv = spawn(
      "node",
      [
        join(HERE, "server.mjs"),
        "--port",
        String(port),
        "--isolate",
        "--demo",
        img,
        "--kick",
        KICK,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    await sleep(600);
    try {
      await c.send("Page.navigate", {
        url: `http://localhost:${port}/?cpu=68020&compat=normal&mode=off&threads=1`,
      });
      // wait for a frame
      let booted = false;
      const t0 = Date.now();
      while (Date.now() - t0 < BOOT) {
        await sleep(1500);
        const h = await hud(c);
        if (h && typeof h.frame === "number" && h.frame > 0) {
          booted = true;
          break;
        }
      }
      // Headless swiftshader freezes the GL canvas (effectiveFps ~0, screenshot
      // black) even when the demo runs perfectly, so the launch signal is the
      // EMULATED frame rate: vblankFps. Boot past the load with FF, then sample
      // the real-time vblank — sustained ≈full speed means the image mounted and
      // is running; never reaching a healthy rate means it's stuck/crashed.
      let maxVbl = 0,
        lastVbl = 0,
        jit = 0;
      if (booted) {
        await c.evals(`window.__setFF&&window.__setFF(true,0)`);
        await sleep(FF * 1000);
        await c.evals(`window.__setFF&&window.__setFF(false)`);
        await sleep(1500); // let the vblank window re-fill at real-time rate
        const tm = Date.now();
        while (Date.now() - tm < WINDOW) {
          await sleep(1000);
          const h = await hud(c);
          if (h) {
            maxVbl = Math.max(maxVbl, h.vblankFps || 0);
            lastVbl = h.vblankFps || 0;
            jit = h.jitStats?.activated || jit;
          }
        }
      }
      // screenshot (black under headless, but kept for the record)
      const shot = await c.send("Page.captureScreenshot", { format: "png" });
      const png = join(OUT, label.replace(/[^\w.-]+/g, "_") + ".png");
      if (shot.result?.data) await writeFile(png, Buffer.from(shot.result.data, "base64"));
      const verdict = !booted ? "NO-BOOT" : maxVbl < 20 ? "SUSPECT" : "OK";
      results.push({
        label,
        verdict,
        maxVbl: +maxVbl.toFixed(0),
        lastVbl: +lastVbl.toFixed(0),
        jit,
        img,
      });
      console.log(
        `${verdict.padEnd(8)} ${label}  (vblank max ${maxVbl.toFixed(0)}/last ${lastVbl.toFixed(0)}, jit ${jit})`,
      );
    } catch (e) {
      results.push({ label, verdict: "ERROR", err: String(e), img });
      console.log(`ERROR    ${label}  ${e}`);
    } finally {
      try {
        srv.kill("SIGKILL");
      } catch {}
    }
  }

  c.close();
  cleanup();
  await writeFile(join(OUT, "report.json"), JSON.stringify(results, null, 2));
  const by = (v) => results.filter((r) => r.verdict === v);
  console.log(`\n=== summary (${results.length}) ===`);
  console.log(
    `OK: ${by("OK").length}  ·  SUSPECT (static/stuck — check screenshot): ${by("SUSPECT").length}  ·  NO-BOOT: ${by("NO-BOOT").length}  ·  ERROR: ${by("ERROR").length}`,
  );
  for (const r of results.filter((r) => r.verdict !== "OK"))
    console.log(`  ${r.verdict}: ${r.label}`);
  console.log(`\nscreenshots + report.json in ${OUT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
