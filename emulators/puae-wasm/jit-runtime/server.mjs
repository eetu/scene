// Static server for the M1 JIT runtime harness.
//
// Serves the harness page, the JIT ESM modules (jit/*, spike/*) at their real
// relative paths so the browser's `import "../jit/coretarget.mjs"` resolves, the
// M1 (JIT-scaffold) EmulatorJS core, one demo disk, and the Kickstart ROM.
//
// Unlike bench/server.mjs it sends NO COOP/COEP: crossOriginIsolated stays
// false so EmulatorJS selects the NON-THREADED core — the core Module then lives
// on the main thread where the browser JIT driver can reach wasmTable/wasmMemory
// and set Module.ejsJitGet.
//
//   node server.mjs \
//     --vendor <m1-vendor-dir> \
//     --demo "/Volumes/scene/parties/Gathering96/amiga/demo/02 - Triumph - Dreamscape/.support/Dreamscape (AGA).hdf" \
//     --kick "/Volumes/scene/parties/.support/kick40068.A1200" \
//     --port 8791
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, basename, join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../puae-wasm/jit-runtime
const PW_ROOT = resolve(HERE, ".."); // .../puae-wasm  (jit/, spike/ live here)
const REPO_ROOT = resolve(HERE, "../../..");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const VENDOR = resolve(
  arg("vendor", join(REPO_ROOT, "apps/party/frontend/static/vendor/emulatorjs")),
);
const DEMO = arg(
  "demo",
  "/Volumes/scene/parties/Gathering96/amiga/demo/02 - Triumph - Dreamscape/.support/Dreamscape (AGA).hdf",
);
const KICK = arg("kick", "/Volumes/scene/parties/.support/kick40068.A1200");
const PORT = Number(arg("port", "8791"));

const DEMO_NAME = basename(DEMO);
const KICK_NAME = basename(KICK);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function sendFile(res, path, typeHint) {
  const st = await stat(path);
  res.setHeader("Content-Type", typeHint || MIME[extname(path)] || "application/octet-stream");
  res.setHeader("Content-Length", st.size);
  res.setHeader("Cache-Control", "no-store");
  createReadStream(path).pipe(res);
}
function notFound(res) {
  res.statusCode = 404;
  res.end("not found");
}
// serve a file from a sandboxed root, rejecting path escapes
function serveUnder(res, root, rel) {
  const target = normalize(join(root, rel));
  if (target !== root && !target.startsWith(root + "/")) return notFound(res);
  return sendFile(res, target).catch(() => notFound(res));
}

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);

    if (p === "/" || p === "/harness.html")
      return sendFile(res, join(HERE, "harness.html"), MIME[".html"]);
    if (p === "/runtime.mjs") return sendFile(res, join(HERE, "runtime.mjs"), MIME[".mjs"]);

    if (p === "/config.json") {
      res.setHeader("Content-Type", MIME[".json"]);
      res.setHeader("Cache-Control", "no-store");
      return res.end(
        JSON.stringify({
          gameUrl: `/disk/${encodeURIComponent(DEMO_NAME)}`,
          biosUrl: `/rom/${encodeURIComponent(KICK_NAME)}`,
          options: {},
        }),
      );
    }
    if (p === `/disk/${DEMO_NAME}`) return sendFile(res, DEMO);
    if (p === `/rom/${KICK_NAME}`) return sendFile(res, KICK);

    // JIT ESM modules at their real relative paths (jit/*, spike/*)
    if (p.startsWith("/jit/") || p.startsWith("/spike/"))
      return serveUnder(res, PW_ROOT, p.slice(1));

    if (p.startsWith("/vendor/emulatorjs/"))
      return serveUnder(res, VENDOR, p.slice("/vendor/emulatorjs/".length));

    return notFound(res);
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`puae-wasm JIT runtime harness: http://localhost:${PORT}/`);
  console.log(`  vendor (M1 core): ${VENDOR}`);
  console.log(`  demo: ${DEMO}`);
  console.log(`  kick: ${KICK}`);
  console.log(`  (no COOP/COEP → non-threaded core, Module on main thread)`);
});
