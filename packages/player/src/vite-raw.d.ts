// Vite's `?raw` import returns the file's text content as a string.
declare module "*?raw" {
  const content: string;
  export default content;
}
