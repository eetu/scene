import process from "node:process";

import adapter from "@sveltejs/adapter-static";

// Non-root base path for the GitHub Pages build (served at eetu.github.io/scene).
// The pages workflow sets BASE_PATH=/scene; the normal backend build leaves it
// empty (served at the origin root). SvelteKit derives Vite's base from this, so
// import.meta.env.BASE_URL follows too (used by the vendored worklet URLs).
const base = process.env.BASE_PATH ?? "";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // Force runes mode (Svelte 5). Can be removed in Svelte 6.
    runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
  },
  kit: {
    paths: { base },
    // Pure SPA: no server-side logic. The Rust backend embeds this and serves
    // the fallback for every unmatched path, so client routing + hard refresh
    // both work. Output to dist/ to match the family convention (the backend's
    // STATIC_DIR / Dockerfile expect it).
    adapter: adapter({
      pages: "dist",
      assets: "dist",
      fallback: "index.html",
      precompress: false,
      strict: true,
    }),
  },
};

export default config;
