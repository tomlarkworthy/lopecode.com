// Bundle the render Worker. exporter-3.js has many dynamic imports of
// other Observable modules (`/@tomlarkworthy/foo.js?v=4`); they're
// only invoked if the corresponding cell is computed, and we only ask
// for `lopebook`, whose deps stay inside exporter-3 itself. Stub them
// at build time so esbuild's static resolver doesn't choke.

import { build } from "esbuild";

const stubModule = `// Stub: this module wasn't bundled because lopebook didn't need it.
// If something else is asking for it at runtime, that's a bug — the
// runtime's lazy evaluation should never reach this code path.
export default function stub_define() {
  throw new Error("stubbed Observable module called at runtime — extend build.mjs to bundle it");
}
`;

await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["worker", "browser"],
  // Workers don't have node:* APIs; mark Observable stdlib externals
  // we don't actually use (data loaders, d3-require) so esbuild can
  // skip them. They're needed only for cells we never compute.
  external: ["d3-require"],
  plugins: [
    {
      name: "stub-observable-modules",
      setup(b) {
        // Match Observable module URLs: /@user/module.js?v=N or /d/hex.js?v=N
        b.onResolve({ filter: /^\/(@[^/]+\/[^?]+|d\/[a-f0-9]+)\.js(\?.*)?$/ }, args => ({
          path: args.path,
          namespace: "stub-obs"
        }));
        b.onLoad({ filter: /.*/, namespace: "stub-obs" }, () => ({
          contents: stubModule,
          loader: "js"
        }));
      }
    }
  ]
});

console.log("built dist/worker.js");
