import { fileURLToPath } from "node:url";

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The monorepo root: the editor reads the sprite files under packages/*, which
// live outside this app's root, so the dev server has to be allowed to serve them.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  server: { port: 5180, fs: { allow: [REPO_ROOT] } },
});
