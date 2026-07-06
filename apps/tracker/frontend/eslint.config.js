import svelte from "@anarkisti/eslint-config/svelte";

import svelteConfig from "./svelte.config.js";

// Shared house preset (node base + eslint-plugin-svelte + TS parser wiring).
// See coding-style:svelte / the eslint-config repo.
export default [
  ...svelte(svelteConfig),
  {
    rules: {
      // Serves at a host root (no SvelteKit base path) and uses query-param
      // navigation (goto) to mirror the open track in ?t=. resolve() (route-id /
      // base-path resolution) doesn't apply. Matches party's config.
      "svelte/no-navigation-without-resolve": "off",
    },
  },
  { ignores: ["dist/", "build/", ".svelte-kit/", "src/lib/vendor/", "static/vendor/"] },
];
