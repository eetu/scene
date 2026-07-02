// Static server for the puae-wasm benchmark harness.
//
// Serves the vendored EmulatorJS core, one demo disk image, and the Kickstart
// ROM — all same-origin with COOP/COEP so the page is crossOriginIsolated and
// the threaded PUAE core is allowed to spin up (matching the party app).
//
//   node server.mjs --demo "/Volumes/scene/parties/Assembly95/amiga/demo/01 - Parallax - ZIF/.support/ZIF (AGA).hdf" \
//                   --kick "/Volumes/scene/parties/.support/kick40068.A1200" \
//                   --port 8790
//
// Then open http://localhost:8790/ (or point bench/measure.mjs at it).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const VENDOR = join(REPO_ROOT, "apps/party/frontend/static/vendor/emulatorjs");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DEMO = arg(
  "demo",
  "/Volumes/scene/parties/Assembly95/amiga/demo/01 - Parallax - ZIF/.support/ZIF (AGA).hdf",
);
const KICK = arg("kick", "/Volumes/scene/parties/.support/kick40068.A1200");
const PORT = Number(arg("port", "8790"));
const TARGET_FPS = Number(arg("target", "50"));

const DEMO_NAME = basename(DEMO); // keep "(AGA)" + extension for PUAE detection
// PUAE identifies the Kickstart by FILENAME (e.g. kick40068.A1200), and
// EmulatorJS names the downloaded BIOS from the basename of EJS_biosUrl — so the
// ROM must be served under its real name or the core reports "ROM not found".
const KICK_NAME = basename(KICK);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".mem": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Cross-origin isolation: required for SharedArrayBuffer / threaded cores.
function isolate(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

async function sendFile(res, path, typeHint) {
  const st = await stat(path);
  isolate(res);
  res.setHeader("Content-Type", typeHint || MIME[extname(path)] || "application/octet-stream");
  res.setHeader("Content-Length", st.size);
  res.setHeader("Cache-Control", "no-store");
  createReadStream(path).pipe(res);
}

function notFound(res) {
  isolate(res);
  res.statusCode = 404;
  res.end("not found");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = decodeURIComponent(url.pathname);

    if (p === "/" || p === "/index.html") {
      return sendFile(res, join(HERE, "index.html"), MIME[".html"]);
    }
    if (p === "/config.json") {
      isolate(res);
      res.setHeader("Content-Type", MIME[".json"]);
      res.setHeader("Cache-Control", "no-store");
      return res.end(
        JSON.stringify({
          gameUrl: `/disk/${encodeURIComponent(DEMO_NAME)}`,
          biosUrl: `/rom/${encodeURIComponent(KICK_NAME)}`,
          targetFps: TARGET_FPS,
          options: {},
        }),
      );
    }
    if (p === `/disk/${DEMO_NAME}`) return sendFile(res, DEMO);
    if (p === `/rom/${KICK_NAME}`) return sendFile(res, KICK);

    if (p.startsWith("/vendor/emulatorjs/")) {
      const rel = p.slice("/vendor/emulatorjs/".length);
      const target = join(VENDOR, rel);
      if (!target.startsWith(VENDOR)) return notFound(res); // path-escape guard
      return sendFile(res, target).catch(() => notFound(res));
    }
    return notFound(res);
  } catch (e) {
    isolate(res);
    res.statusCode = 500;
    res.end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`puae-wasm bench: http://localhost:${PORT}/`);
  console.log(`  demo: ${DEMO}`);
  console.log(`  kick: ${KICK}`);
  console.log(`  target: ${TARGET_FPS} fps (PAL)`);
});
