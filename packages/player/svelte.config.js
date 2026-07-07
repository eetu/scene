import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// This package ships source-only; the config exists for its own vitest browser
// tests (the consuming app's config governs real builds). Force runes mode to
// match the apps (Svelte 5).
export default {
  preprocess: vitePreprocess(),
  compilerOptions: { runes: true },
};
