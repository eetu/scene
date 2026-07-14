import { sveltekit } from "@sveltejs/kit/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { playwright } from "@vitest/browser-playwright";
import { qrcode } from "vite-plugin-qrcode";
import { defineConfig } from "vitest/config";

// `yarn dev:host` (or `just dev tracker host`) exposes the dev server on the LAN
// over HTTPS and prints the network URL (+ a QR to scan), so another device on
// the network — phone, tablet, or another laptop — can connect. HTTPS via a
// self-signed cert (accept the one-time warning on the device). Off by default
// so plain `yarn dev` and the vitest browser tests stay localhost/http.
const exposeHost = !!process.env.DEV_HOST;

export default defineConfig({
  plugins: [sveltekit(), ...(exposeHost ? [basicSsl(), qrcode()] : [])],
  server: {
    ...(exposeHost ? { host: true } : {}),
    // Dev: proxy the backend so the SPA is same-origin in dev as in prod.
    // The backend listens on 3010 (TRACKER_BIND default). The proxy runs on this
    // machine, so `localhost` still resolves to the backend even from a phone.
    proxy: {
      "/api": "http://localhost:3010",
      "/status": "http://localhost:3010",
    },
  },
  // Two vitest projects, split by filename (see the testing skill):
  //   unit    — *.test.ts        → node, pure logic (api layer, parsers, stores)
  //   browser — *.svelte.test.ts → real headless chromium, component render
  // Playwright (e2e/) stays for the shipped-bundle playback guard + true e2e.
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
