// End-to-end smoke: pretend to be the Worker handling a request for
// a real published bundle. Fetches the bundle from PDS, fetches each
// blob, calls lopebook, writes the HTML to disk for visual inspection.

import fs from "node:fs/promises";
import { parseHTML } from "linkedom";
import { Runtime } from "@observablehq/runtime";
import { Library } from "@observablehq/stdlib";
import define from "./exporter-3.js";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
globalThis.document = dom.document;
globalThis.window = dom;
globalThis.HTMLElement = dom.HTMLElement;
globalThis.Node = dom.Node;
globalThis.DocumentFragment = dom.DocumentFragment;

const runtime = new Runtime(new Library());
const main = runtime.module(define, () => null);
const lopebook = await main.value("lopebook");

const DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
const RKEY = "3mkshbxcynv2z";

const plc = await fetch(`https://plc.directory/${DID}`).then(r => r.json());
const pds = plc.service.find(s => s.id === "#atproto_pds").serviceEndpoint;
console.log("PDS:", pds);

const record = await fetch(
  `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(DID)}&collection=com.lopecode.bundle&rkey=${RKEY}`
).then(r => r.json());

const files = record.value.files;
console.log(`bundle has ${files.length} files`);

const t0 = Date.now();
const blobBytes = await Promise.all(
  files.map(async f => {
    const r = await fetch(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=${f.blob.ref.$link}`);
    return new Uint8Array(await r.arrayBuffer());
  })
);
console.log(`fetched ${blobBytes.length} blobs in ${Date.now() - t0}ms`);

const bytesToBase64 = bytes => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};
const escapeAttr = s => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const escapeScriptTags = s => s.replaceAll("</scr\\ipt", "</scr\\\\ipt");

const blocks = files
  .map((f, i) => {
    const text = f.encoding === "text" ? new TextDecoder().decode(blobBytes[i]) : bytesToBase64(blobBytes[i]);
    return `<script id="${escapeAttr(f.id)}" type="text/plain" data-mime="${escapeAttr(f.blob.mimeType)}" data-encoding="${f.encoding}">
${escapeScriptTags(text)}
</script>`;
  })
  .join("\n\n");

const html = lopebook({ title: record.value.title || "Lopebook", blocks });

await fs.writeFile("dist/test-render.html", html);
console.log(`wrote ${html.length} bytes to dist/test-render.html`);
