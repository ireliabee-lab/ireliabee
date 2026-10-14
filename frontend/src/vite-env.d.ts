/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

// citeproc-js ships CommonJS without types (lib/citations.ts describes the part Write uses).
declare module "citeproc";
