import svelte from '@anarkisti/eslint-config/svelte';

import svelteConfig from './svelte.config.js';

// Shared house preset (node base + eslint-plugin-svelte + TS parser wiring).
// See coding-style:svelte / the eslint-config repo.
export default [
	...svelte(svelteConfig),
	{
		rules: {
			// Served at a host root (no SvelteKit base path); the only navigation is
			// a same-route ?t query update (replaceState). resolve() doesn't apply.
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{ ignores: ['dist/', 'build/', '.svelte-kit/', 'src/lib/vendor/', 'static/vendor/'] }
];
