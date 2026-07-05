// Truthful render oracle — does the emulator actually draw the demo, or a BLACK
// screen? This exists because the older batch.mjs only measured vblankFps (the
// emulated frame counter), which keeps ticking even when the display is black or
// corrupt — so it happily reported "OK" for demos that rendered nothing (e.g. the
// JIT core's self-modifying-code corruption). Here we read the ACTUAL canvas
// pixels and judge black vs rendered.
//
// The catch that made this hard: chrome-headless-shell has no GPU, so it falls
// back to swiftshader which freezes the GL canvas → every screenshot is black,
// telling you nothing. So this REQUIRES the full Chrome-for-Testing (real Metal
// GL). We connect over CDP (needs --remote-allow-origins=*), boot the demo via
// the harness with the app's config, fast-forward past the load, then sample the
// canvas histogram over a window and keep the liveliest frame.
//
//   node render-check.mjs --demo "<hdf>" [--kick <rom>] [--compat normal|exact]
//                         [--out shot.png] [--secs 12]
// Reads the vendored core from static/vendor/emulatorjs — swap that (stock vs JIT)
// to A/B which core renders. Threaded (HDF).
import { spawn } from "node:child_process";
import { readdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DEMO = arg(
  "demo",
  "/Volumes/scene/parties/Assembly95/amiga/demo/01 - Parallax - ZIF/.support/ZIF (AGA).hdf",
);
const KICK = arg("kick", "/Volumes/scene/parties/.support/kick40068.A1200");
const COMPAT = arg("compat", "normal");
const OUT = arg("out", null);
const SECS = Number(arg("secs", "12"));
const PORT = Number(arg("port", "8896"));
const DBG = 9488;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Full Chrome-for-Testing ONLY (real GL). headless-shell = swiftshader = useless.
async function findChrome() {
  const cache = join(process.env.HOME, "Library/Caches/ms-playwright");
  for (const d of await readdir(cache)) {
    if (!d.startsWith("chromium-")) continue; // note: NOT chromium_headless_shell
    for (const sub of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ]) {
      const p = join(cache, d, sub);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("full Chrome-for-Testing not found (need real GL, not headless-shell)");
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

// In-page: read the emulator's <canvas>, downscale to 80×60, return a histogram.
// distinctColors (5-bit/channel buckets) is the key black-vs-rendered signal: a
// black/flat screen has ≤2 buckets, a real demo frame has many.
const ANALYZE = `(() => {
  const cs = [...document.querySelectorAll('canvas')].filter(c => c.width > 16 && c.height > 16);
  const c = cs.sort((a,b)=>b.width*b.height - a.width*a.height)[0];
  if (!c) return null;
  const w=80,h=60, t=document.createElement('canvas'); t.width=w; t.height=h;
  const x=t.getContext('2d',{willReadFrequently:true});
  try { x.drawImage(c,0,0,w,h); } catch(e) { return {error:String(e)}; }
  let d; try { d=x.getImageData(0,0,w,h).data; } catch(e){ return {error:'tainted:'+e}; }
  const n=w*h; let nonBlack=0; const buckets=new Set(); let sum=0,sum2=0;
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2]; const lum=r+g+b;
    if(lum>24) nonBlack++;
    buckets.add((r>>3)+'_'+(g>>3)+'_'+(b>>3));
    sum+=lum; sum2+=lum*lum;
  }
  const mean=sum/n;
  return { w:c.width, h:c.height, nonBlackFrac:+(nonBlack/n).toFixed(3), distinctColors:buckets.size, variance:Math.round(sum2/n-mean*mean) };
})()`;

async function main() {
  const chrome = await findChrome();
  const label = basename(DEMO).replace(/\.(adf|hdf)$/i, "");
  console.log(`chrome: ${chrome.split("/").pop()}\ndemo: ${label}\ncompat: ${COMPAT}\n`);

  const profile = await mkdtemp(join(tmpdir(), "render-"));
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
  if (!wsUrl) throw new Error("no CDP page target (is --remote-allow-origins set?)");
  const c = cdp(wsUrl);
  await c.ready;
  await c.send("Page.enable");
  await c.send("Runtime.enable");

  // confirm real GL (else the whole check is meaningless)
  await c.send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  const renderer = await c.evals(
    `(()=>{const g=document.createElement('canvas').getContext('webgl2');if(!g)return'no-webgl2';const e=g.getExtension('WEBGL_debug_renderer_info');return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):'webgl2-ok'})()`,
  );
  console.log(
    "WebGL2 renderer:",
    renderer,
    renderer && /swiftshader|software/i.test(renderer) ? "⚠️ SOFTWARE — results invalid!" : "",
  );

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
    const h = await c
      .evals("JSON.stringify(window.__hud||null)")
      .then((s) => (s ? JSON.parse(s) : null));
    if (h && h.frame > 0) booted = true;
  }
  if (!booted) {
    console.log("NO-BOOT (never advanced a frame)");
    c.close();
    cr.kill("SIGKILL");
    try {
      srv.kill("SIGKILL");
    } catch {}
    process.exit(2);
  }
  await c.evals("window.__setFF&&window.__setFF(true,0)");
  await sleep(6000); // FF past the load
  await c.evals("window.__setFF&&window.__setFF(false)");

  // sample the canvas over a window; keep the liveliest frame (demos animate)
  let best = { distinctColors: 0 };
  for (let i = 0; i < SECS; i++) {
    await sleep(1000);
    const a = await c.evals(ANALYZE);
    if (a && !a.error && a.distinctColors > best.distinctColors) best = a;
    if (a?.error) best.error = a.error;
  }

  if (OUT) {
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    if (shot.result?.data) {
      await writeFile(OUT, Buffer.from(shot.result.data, "base64"));
      console.log("screenshot:", OUT);
    }
  }

  // Verdict: a real demo frame has many distinct colours + meaningful non-black
  // area; a black/flat screen collapses to a handful of buckets.
  const rendered = best.distinctColors >= 8 && best.nonBlackFrac >= 0.03;
  console.log(
    `\ncanvas ${best.w}×${best.h}  distinctColors=${best.distinctColors}  nonBlackFrac=${best.nonBlackFrac}  variance=${best.variance}${best.error ? "  err=" + best.error : ""}`,
  );
  console.log(`VERDICT: ${rendered ? "✅ RENDERED" : "⬛ BLACK / not rendering"}`);
  c.close();
  cr.kill("SIGKILL");
  try {
    srv.kill("SIGKILL");
  } catch {}
  process.exit(rendered ? 0 : 1);
}
main().catch((e) => (console.error(e), process.exit(3)));
