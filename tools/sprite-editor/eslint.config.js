import svelte from "@anarkisti/eslint-config/svelte";

import svelteConfig from "./svelte.config.js";

// The house preset. This is a dev tool, not a shipped app, but it lives in the
// same workspace and reads better held to the same rules.
export default [...svelte(svelteConfig), { ignores: ["dist/"] }];
