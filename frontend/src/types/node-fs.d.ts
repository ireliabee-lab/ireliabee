/**
 * Tests run in Node (vitest) but the app is browser-only, so this project
 * carries no Node types. One test reads notebook.css to check the ruled
 * paper's rhythm — Vite hands back an empty string for a stylesheet — and
 * this is all it needs.
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
