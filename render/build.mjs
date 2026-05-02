// Worker bundle build step.
//
// Why we run our own esbuild instead of letting wrangler bundle directly:
// exporter-3.js contains `await import("/@user/module.js?v=4")` inside
// cell function bodies that the live Observable runtime would resolve
// at runtime via the CDN. Our render path never invokes those cells —
// we only resolve `lopebook` and its closure (diskDataUrl, networking_
// script, normalize, isNotebook) — so the imports are dead code. But
// esbuild walks every static import string and fails when it can't
// resolve them. Marking them external tells esbuild to leave the calls
// alone; if anything ever invokes them at runtime they'll fail, but
// nothing should.

import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: "dist/worker.js",
  // Dormant Observable CDN imports inside exporter-3 cells we never run.
  external: [
    "/@*",
    "/d/*",
    "https://api.observablehq.com/*"
  ],
  logLevel: "info"
});
