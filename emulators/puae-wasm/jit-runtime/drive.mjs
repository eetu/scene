// Headless driver for the M1 JIT runtime harness. Boots server.mjs + a cached
// chrome-headless-shell (over the DevTools Protocol, no npm deps), loads the
// harness (which boots the demo on the M1 core and installs the ejsJitGet
// self-test), and reports the substrate result:
//
//   does the EM_JS hook reach JS · are the jit ABI + wasmTable/wasmMemory
//   reachable · does a Node-validated block install into the core's table and
//   correctly mutate the REAL 68k register file + md-generic flags in-situ.
//
//   node drive.mjs --vendor <m1-vendor> [--demo <p>] [--kick <p>] [--wait 90]
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
const PORT = Number(arg("port", "8791"));
const DBG = Number(arg("dbg", "9334"));
const WAIT = Number(arg("wait", "90")) * 1000;
const MODE = arg("mode", "selftest"); // selftest | probe
const PROBE_SECS = Number(arg("probe-secs", "60")) * 1000; // how long to let probe run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  throw new Error("chrome-headless-shell not found; pass --chrome <path>");
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
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  return { ready, send, evals, close: () => ws.close() };
}

const getJson = (path) => fetch(`http://127.0.0.1:${DBG}${path}`).then((r) => r.json());

async function main() {
  const chrome = await findChrome();
  console.log(`chrome: ${chrome}`);

  const passthrough = [];
  for (const k of ["demo", "kick", "vendor"]) {
    const v = arg(k, "");
    if (v) passthrough.push(`--${k}`, v);
  }
  const srv = spawn("node", [join(HERE, "server.mjs"), "--port", String(PORT), ...passthrough], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  await sleep(500);

  const profile = await mkdtemp(join(tmpdir(), "puae-jit-"));
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
  await c.send("Page.navigate", {
    url: `http://localhost:${PORT}/?cpu=68030&compat=normal&mode=${MODE}`,
  });

  if (MODE === "probe") return probeMode(c, crlog, cleanup);
  if (MODE === "jit" || MODE === "off") return fpsMode(c, crlog, cleanup);

  console.log(`\nwaiting up to ${WAIT / 1000}s for boot + self-test…`);
  const t0 = Date.now();
  let last = null;
  let result = null;
  while (Date.now() - t0 < WAIT) {
    await sleep(2000);
    const hud = await c.evals("JSON.stringify(window.__hud||null)");
    const h = hud && !hud.__err ? JSON.parse(hud) : null;
    if (h) {
      const line = `  t+${((Date.now() - t0) / 1000).toFixed(0)}s  core:${h.status}  frame:${h.frame}${h.selfTest ? "  self-test:" + (h.selfTest.pass ? "PASS" : "FAIL") : ""}`;
      if (line !== last) {
        console.log(line);
        last = line;
      }
      if (h.selfTest) {
        result = h.selfTest;
        break;
      }
    }
  }

  c.close();
  cleanup();

  console.log("\n=== M1 JIT runtime self-test ===");
  if (!result) {
    console.log("❌ no self-test result (core Module never reached, or hook never fired).");
    console.log("   Chrome stderr tail:\n" + crlog.slice(-1000));
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.pass) {
    console.log(
      "\n✅ M1 substrate proven IN-SITU: EM_JS hook → JS → real ABI → block installed in the",
    );
    console.log("   core's table → correct mutation of the real 68k reg file + md-generic flags.");
    process.exit(0);
  } else {
    console.log("\n❌ self-test FAILED — see mismatches/error above.");
    process.exit(1);
  }
}

// fps mode (jit | off): let the demo boot + animate, then sample effectiveFps /
// vblank / jit stats for a window and report — the JIT-vs-interpreter baseline.
async function fpsMode(c, crlog, cleanup) {
  const measure = Number(arg("measure", "20")) * 1000;
  console.log(`\nmode=${MODE}: waiting for boot + animation, then measuring ${measure / 1000}s…`);
  const t0 = Date.now();
  // wait until a frame is produced
  let booted = false;
  while (Date.now() - t0 < 60000) {
    await sleep(2000);
    const hud = await c.evals("JSON.stringify(window.__hud||null)");
    const h = hud && !hud.__err ? JSON.parse(hud) : null;
    if (h && typeof h.frame === "number" && h.frame > 0) {
      console.log(`  booted (core:${h.status}, frame ${h.frame})`);
      booted = true;
      break;
    }
  }
  if (!booted) {
    c.close();
    cleanup();
    console.log("❌ never produced a frame.\n" + crlog.slice(-1000));
    process.exit(2);
  }
  // Fast-forward past the HD boot / trackload to the heavy effect (unlimited
  // ratio = as fast as the host manages), then drop back to 1× to measure the
  // true (host-bound) rate — same approach as bench/measure.mjs.
  const ff = Number(arg("ff", "35")) * 1000;
  let ffThroughput = null;
  if (ff > 0) {
    console.log(`  fast-forwarding ~${ff / 1000}s (also measures emulation throughput)…`);
    await c.evals("window.__setFF(true, 0)");
    await sleep(2000); // let FF spin up before sampling throughput
    const fh0 = JSON.parse((await c.evals("JSON.stringify(window.__hud||null)")) || "null");
    const f0 = fh0 ? fh0.frame : 0,
      w0 = Date.now();
    const fe = Date.now();
    while (Date.now() - fe < ff) {
      await sleep(3000);
      const h = JSON.parse((await c.evals("JSON.stringify(window.__hud||null)")) || "null");
      if (h) process.stdout.write(`    ff… frame ${h.frame}  effective ${h.effectiveFps}\n`);
    }
    const fh1 = JSON.parse((await c.evals("JSON.stringify(window.__hud||null)")) || "null");
    const f1 = fh1 ? fh1.frame : 0,
      w1 = Date.now();
    ffThroughput = +(((f1 - f0) * 1000) / (w1 - w0)).toFixed(1); // emulated frames / wall-sec
    console.log(
      `  FF throughput: ${ffThroughput} emulated-frames/wall-sec (${f1 - f0} frames in ${((w1 - w0) / 1000).toFixed(1)}s)`,
    );
    await c.evals("window.__setFF(false)");
    await sleep(1500);
  }
  fpsMode._ffThroughput = ffThroughput;

  const eff = [],
    vbl = [];
  let lastStats = null;
  const tm = Date.now();
  while (Date.now() - tm < measure) {
    await sleep(1000);
    const h = JSON.parse((await c.evals("JSON.stringify(window.__hud||null)")) || "null");
    if (!h) continue;
    eff.push(h.effectiveFps);
    vbl.push(h.vblankFps);
    lastStats = h.jitStats;
    process.stdout.write(
      `  effective ${h.effectiveFps}fps  vblank ${h.vblankFps}  frame ${h.frame}` +
        (h.jitStats ? `  jit ${h.jitStats.activated}act/${h.jitStats.gateFail}gf` : "") +
        (h.hashOk ? "" : "  [canvas unreadable]") +
        "\n",
    );
  }
  const gateFails = JSON.parse(
    (await c.evals("JSON.stringify(window.__jitGateFails||null)")) || "null",
  );
  c.close();
  cleanup();

  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0);
  console.log(`\n=== mode=${MODE} — ${eff.length} samples ===`);
  if (fpsMode._ffThroughput != null)
    console.log(`FF throughput: ${fpsMode._ffThroughput} emulated-frames/wall-sec`);
  console.log(`effectiveFps: median ${med(eff)}  mean ${mean(eff)}   vblankFps mean ${mean(vbl)}`);
  if (lastStats) console.log("jitStats:", JSON.stringify(lastStats));
  if (gateFails && gateFails.length)
    console.log("gateFails (first few):", JSON.stringify(gateFails, null, 2));
  process.exit(0);
}

// Probe mode: let the demo run, sampling live decoder-coverage stats, then dump.
async function probeMode(c, crlog, cleanup) {
  console.log(`\nprobing live blocks for ${PROBE_SECS / 1000}s…`);
  const t0 = Date.now();
  let last = "";
  let pr = null;
  while (Date.now() - t0 < PROBE_SECS) {
    await sleep(3000);
    const hud = await c.evals("JSON.stringify(window.__hud||null)");
    const h = hud && !hud.__err ? JSON.parse(hud) : null;
    if (h && h.probe) {
      pr = h.probe;
      const top = pr.topMissFamilies[0];
      const line = `  t+${((Date.now() - t0) / 1000).toFixed(0)}s  core:${h.status}  frame:${h.frame}  blocks:${pr.uniqueProbed}  cov ${pr.decoderCoverage}%  topMiss:${top ? top.family + "(" + top.n + ")" : "—"}`;
      if (line !== last) {
        console.log(line);
        last = line;
      }
    }
  }
  c.close();
  cleanup();

  console.log("\n=== M1 JIT live coverage probe ===");
  if (!pr) {
    console.log("❌ no probe data (core Module never reached, or hook never fired).");
    console.log("   Chrome stderr tail:\n" + crlog.slice(-1000));
    process.exit(2);
  }
  console.log(JSON.stringify(pr, null, 2));
  console.log(
    `\ndecoder covers ${pr.decoderCoverage}% of ${pr.uniqueProbed} live RAM blocks ` +
      `(avg ${pr.avgBlockLen} instrs, max ${pr.maxBlockLen}).`,
  );
  console.log("Top miss families above scope the codegen/decoder widening for the hot path.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
