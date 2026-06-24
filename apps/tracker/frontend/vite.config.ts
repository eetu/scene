import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		// Dev: proxy the backend so the SPA is same-origin in dev as in prod.
		// The backend listens on 3010 (TRACKER_BIND default).
		proxy: {
			'/api': 'http://localhost:3010',
			'/status': 'http://localhost:3010'
		}
	}
});
