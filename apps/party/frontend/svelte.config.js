import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode (Svelte 5). Can be removed in Svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// Pure SPA: no server-side logic. The Rust backend embeds this and serves
		// the fallback for every unmatched path, so client routing + hard refresh
		// both work. Output to dist/ to match the family convention (the backend's
		// STATIC_DIR / Dockerfile expect it).
		adapter: adapter({
			pages: 'dist',
			assets: 'dist',
			fallback: 'index.html',
			precompress: false,
			strict: true
		})
	}
};

export default config;
