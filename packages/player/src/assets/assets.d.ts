// Asset imports resolve to their emitted URL (Vite). Declared here so the
// package type-checks on its own, independent of the consumer's vite/client.
declare module "*.jpg" {
  const url: string;
  export default url;
}
declare module "*.webp" {
  const url: string;
  export default url;
}
// The dancer viz's baked poses (see ./README.md). Imported via
// `import.meta.glob`, so an absent file is simply no match — never a build error.
declare module "*.bin" {
  const url: string;
  export default url;
}
