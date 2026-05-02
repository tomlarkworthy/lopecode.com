// CLI smoke test: fetch a real bundle from atproto and run it through
// renderBundle, writing the output to dist/test-render.html. Mirrors
// what the Worker does, minus the request plumbing.
//
//   node src/test-render.mjs            # default rkey
//   node src/test-render.mjs <rkey>     # specific bundle

import fs from "node:fs/promises";
import { renderBundle } from "./render.mjs";

const DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
const RKEY = process.argv[2] || "3mkshbxcynv2z";

const plc = await fetch(`https://plc.directory/${DID}`).then(r => r.json());
const pds = plc.service.find(s => s.id === "#atproto_pds").serviceEndpoint;

const record = await fetch(
  `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(DID)}&collection=com.lopecode.bundle&rkey=${RKEY}`
).then(r => r.json());

console.log(`bundle ${RKEY}: ${record.value.files.length} files`);

const blobs = new Map();
await Promise.all(
  record.value.files.map(async f => {
    const r = await fetch(
      `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=${f.blob.ref.$link}`
    );
    blobs.set(f.id, new Uint8Array(await r.arrayBuffer()));
  })
);
console.log(`fetched ${blobs.size} blobs`);

const html = await renderBundle({ record, blobs });
// Write outside dist/ — wrangler ships dist/ as the deploy bundle and
// would attach this 2MB+ smoke-test artifact otherwise.
await fs.mkdir("tmp", { recursive: true });
await fs.writeFile("tmp/test-render.html", html);
console.log(`wrote ${html.length} bytes to tmp/test-render.html`);
