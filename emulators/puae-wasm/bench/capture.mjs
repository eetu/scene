// Screenshot capture for the puae-wasm bench — grabs COMPOSITED frames via CDP
// Page.captureScreenshot (works off a WebGL canvas regardless of
// preserveDrawingBuffer, and bypasses macOS screencapture TCC). Saves PNGs and
// reports the pixel-diff between consecutive shots, so we can tell a static
// intro (0% diff) from a genuinely animating — but laggy — demo.
//
//   node capture.mjs [--cfg "cpu=68030&compat=normal"] [--count 6] [--interval 2]
//                    [--out <dir>] [--port 8795]
import { spawn } from "node:child_process";
import { readdir, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const CFG = arg("cfg", "cpu=68030&compat=normal");
const COUNT = Number(arg("count", "6"));
const INTERVAL = Number(arg("interval", "2")) * 1000;
const PORT = Number(arg("port", "8795"));
const OUT = arg("out", join(HERE, "shots"));
const DBG = 9334;
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
  const send = (method, params = {}, timeoutMs = 0) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
      if (timeoutMs)
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid);
            rej(new Error(`${method} timed out`));
          }
        }, timeoutMs);
    });
  const evals = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.result?.value;
  };
  return { ready, send, evals, close: () => ws.close() };
}
const getJson = (path) => fetch(`http://127.0.0.1:${DBG}${path}`).then((r) => r.json());

// cheap pixel-diff ratio between two PNG buffers (decode-free: compare raw bytes
// after the header — good enough to distinguish identical vs changed frames).
function diffRatio(a, b) {
  if (!a || !b) return 1;
  const n = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 100; i < n; i += 7) if (a[i] !== b[i]) diff++;
  return diff / (n / 7);
}

async function main() {
  const chrome = await findChrome();
  await mkdir(OUT, { recursive: true });
  const pass = [];
  for (const k of ["demo", "kick"]) {
    const v = arg(k, "");
    if (v) pass.push(`--${k}`, v);
  }
  const srv = spawn("node", [join(HERE, "server.mjs"), "--port", String(PORT), ...pass], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  await sleep(500);
  const profile = await mkdtemp(join(tmpdir(), "puae-cap-"));
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
  const cleanup = () => {
    try {
      cr.kill("SIGKILL");
    } catch {}
    try {
      srv.kill("SIGKILL");
    } catch {}
  };
  process.on("exit", cleanup);

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
  await c.send("Page.navigate", { url: `http://localhost:${PORT}/?${CFG}` });

  // wait for a frame
  for (let i = 0; i < 90; i++) {
    const f = await c.evals("(window.__bench&&window.__bench.frame)||0");
    if (f > 0) break;
    await sleep(500);
  }
  console.log(`booted [${CFG}] — capturing ${COUNT} shots @ ${INTERVAL / 1000}s`);

  let prev = null;
  for (let i = 0; i < COUNT; i++) {
    let shot;
    try {
      shot = await c.send("Page.captureScreenshot", { format: "png", fromSurface: true }, 8000);
    } catch (e) {
      console.log(`  #${i} screenshot ${e.message} — skipping`);
      await sleep(INTERVAL);
      continue;
    }
    const buf = Buffer.from(shot.result.data, "base64");
    const b = JSON.parse((await c.evals("JSON.stringify(window.__bench||null)")) || "null");
    const path = join(OUT, `shot-${String(i).padStart(2, "0")}.png`);
    await writeFile(path, buf);
    const dr = prev ? (diffRatio(prev, buf) * 100).toFixed(1) : "—";
    console.log(
      `  #${i}  t+${b?.elapsed}s  vblank ${b?.vblankFps}  frame ${b?.frame}  diff-from-prev ${dr}%  → ${path}`,
    );
    prev = buf;
    await sleep(INTERVAL);
  }
  c.close();
  cleanup();
  console.log(`\nshots in ${OUT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
