import { sveltekit } from "@sveltejs/kit/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { playwright } from "@vitest/browser-playwright";
import { type PluginOption } from "vite";
import { qrcode } from "vite-plugin-qrcode";
import { defineConfig } from "vitest/config";

// Cross-origin isolation in dev (COOP+COEP) so SharedArrayBuffer — hence the
// threaded emulator cores — is available under `vite dev`, matching the
// backend's prod headers. `server.headers` alone doesn't cover the
// SvelteKit-served HTML document, so inject via middleware (runs first).
function crossOriginIsolation(): PluginOption {
  return {
    name: "cross-origin-isolation",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        next();
      });
    },
  };
}

// `yarn dev:host` (or `just dev party host`) exposes the dev server on the LAN
// over HTTPS and prints the network URL (+ a QR to scan), so another device on
// the network can connect. HTTPS matters here beyond convenience: the emulators
// need SharedArrayBuffer (see the COOP/COEP note above), which requires a secure
// context — `http://<lan-ip>` is not one, so plain-http LAN can't run them. A
// self-signed cert (accept the one-time device warning) makes the origin secure.
// Off by default so plain `yarn dev` and the vitest browser tests stay
// localhost/http.
const exposeHost = !!process.env.DEV_HOST;

export default defineConfig({
  plugins: [crossOriginIsolation(), sveltekit(), ...(exposeHost ? [basicSsl(), qrcode()] : [])],
  server: {
    ...(exposeHost ? { host: true } : {}),
    // Dev: proxy the backend so the SPA is same-origin in dev as in prod.
    // The backend listens on 3020 (PARTY_BIND default). The proxy runs on this
    // machine, so `localhost` still resolves to the backend even from a phone.
    proxy: {
      "/api": "http://localhost:3020",
      "/status": "http://localhost:3020",
    },
  },
  // Same two-project split as the tracker frontend (see the testing skill):
  //   unit    — *.test.ts        → node, pure logic
  //   browser — *.svelte.test.ts → real headless chromium, component render
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.{test,spec}.{js,ts}"],
          exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.svelte.{test,spec}.{js,ts}"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
