import svelte from "@anarkisti/eslint-config/svelte";

import svelteConfig from "./svelte.config.js";

// Shared house preset (node base + eslint-plugin-svelte + TS parser wiring).
// See coding-style:svelte / the eslint-config repo.
export default [
  ...svelte(svelteConfig),
  {
    rules: {
      // This app serves at a host root (no SvelteKit base path) and links to
      // backend /api endpoints + uses query-param navigation (goto). resolve()
      // (route-id / base-path resolution) doesn't apply here.
      "svelte/no-navigation-without-resolve": "off",
    },
  },
  {
    // The emulator wrappers integrate imperative vendored runtimes (js-dos /
    // EmulatorJS): they mount into a managed <div> (DOM manipulation IS the
    // integration point) and use ambient js-dos globals/types declared in
    // app.d.ts (TS verifies them; the svelte parser's no-undef can't see
    // ambient types).
    files: ["src/lib/Emulator.svelte", "src/lib/EjsEmulator.svelte"],
    rules: {
      "svelte/no-dom-manipulating": "off",
      "no-undef": "off",
    },
  },
  { ignores: ["dist/", "build/", ".svelte-kit/", "src/lib/vendor/", "static/vendor/"] },
];
