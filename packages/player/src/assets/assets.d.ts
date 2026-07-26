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
// Operator-supplied 3D assets (the dancer viz's figure). Imported via
// `import.meta.glob`, so an absent file is simply no match — never a build error.
declare module "*.glb" {
  const url: string;
  export default url;
}
declare module "*.fbx" {
  const url: string;
  export default url;
}
