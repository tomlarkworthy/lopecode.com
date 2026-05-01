// Smoke test: boot Observable runtime + exporter-3 in Node with linkedom,
// pull the `lopebook` cell value, and call it with a tiny synthetic
// blocks string. Goal: prove the cell evaluates to a function that
// emits HTML, without needing the full module graph. If this works in
// Node, the same approach should bundle for Workers via esbuild.

import { parseHTML } from "linkedom";
import { Runtime } from "@observablehq/runtime";
import { Library } from "@observablehq/stdlib";
import define from "./exporter-3.js";

// Set up a minimal global DOM via linkedom — Observable stdlib's `html`
// (htl) needs document/HTMLElement. linkedom provides both.
const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
globalThis.document = dom.document;
globalThis.window = dom;
globalThis.HTMLElement = dom.HTMLElement;
globalThis.Node = dom.Node;
globalThis.DocumentFragment = dom.DocumentFragment;

const runtime = new Runtime(new Library());
const main = runtime.module(define, name => {
  // Empty observer — we don't need to render, just want cell values.
  return name === "lopebook" || name === "networking_script" || name === "diskDataUrl"
    ? { fulfilled: () => {}, rejected: e => console.error("rejected:", name, e) }
    : null;
});

try {
  const lopebook = await main.value("lopebook");
  console.log("lopebook type:", typeof lopebook);
  if (typeof lopebook !== "function") throw new Error("lopebook is not a function");

  const html = lopebook({
    title: "Test bundle",
    blocks: `<script type="text/plain" id="hello.txt" data-mime="text/plain" data-encoding="text">Hello world</script>`
  });

  console.log("--- emitted HTML (first 500 chars) ---");
  console.log(html.slice(0, 500));
  console.log("---");
  console.log(`Total length: ${html.length} chars`);
} catch (err) {
  console.error("FAILED:", err);
  process.exit(1);
}
