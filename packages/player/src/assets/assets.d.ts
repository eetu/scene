// Asset imports resolve to their emitted URL (Vite). Declared here so the
// package type-checks on its own, independent of the consumer's vite/client.
declare module '*.jpg' {
	const url: string;
	export default url;
}
declare module '*.webp' {
	const url: string;
	export default url;
}
