import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type PluginOption } from "vite";

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

export default defineConfig({
  plugins: [crossOriginIsolation(), sveltekit()],
  server: {
    // Dev: proxy the backend so the SPA is same-origin in dev as in prod.
    // The backend listens on 3020 (PARTY_BIND default).
    proxy: {
      "/api": "http://localhost:3020",
      "/status": "http://localhost:3020",
    },
  },
});
