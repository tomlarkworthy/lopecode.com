// node --test src/render.test.mjs
//
// Guards the streaming layout, which is the only reason a served frame boots
// before it has finished downloading. Two properties, both invisible in a diff:
//
//  1. Block order is passed through untouched. exporter-3's `streamingModuleOrder`
//     decides it at export time (mains first, then ascending emitted-block size)
//     and the bundle preserves it as DOM order, so render must not re-sort.
//  2. The chrome brackets the blocks: `<script id="main">` before the first one,
//     `streaming_sentinel` after the last. Reverse either and nothing runs until
//     the whole document has arrived.

import test from "node:test";
import assert from "node:assert/strict";
import { renderBundle } from "./render.mjs";

const file = (id, text, mimeType = "application/javascript") => ({
  id,
  encoding: "text",
  blob: { mimeType, ref: { $link: `cid-${id}` } }
});

const bundleOf = ids => ({
  value: { title: "t", files: ids.map(id => file(id)) }
});

const blobsOf = ids =>
  new Map(ids.map(id => [id, new TextEncoder().encode(`/* ${id} */`)]));

// Deliberately NOT alphabetical and NOT size-ordered: any sort at all reorders it.
const IDS = [
  "bootconf.json",
  "@u/zeta",
  "@u/alpha",
  "@u/mid",
  "@u/beta"
];

test("block order is the bundle's file order, not a sort", async () => {
  const html = await renderBundle({ record: bundleOf(IDS), blobs: blobsOf(IDS) });
  const seen = [...html.matchAll(/<script id="([^"]+)"\n  type="text\/plain"/g)].map(m => m[1]);
  assert.deepEqual(seen, IDS);
});

test("main script precedes the blocks and the sentinel follows them", async () => {
  const html = await renderBundle({ record: bundleOf(IDS), blobs: blobsOf(IDS) });
  const main = html.indexOf('<script id="main"');
  const first = html.indexOf('<script id="bootconf.json"');
  const last = html.indexOf('<script id="@u/beta"');
  const sentinel = html.indexOf('id="streaming_sentinel"');

  assert.ok(main > 0, "no main script");
  assert.ok(sentinel > 0, "no streaming sentinel");
  assert.ok(main < first, `main at ${main} must precede the first block at ${first}`);
  assert.ok(last < sentinel, `sentinel at ${sentinel} must follow the last block at ${last}`);
  // A deferred/module main would run after parse, defeating the whole layout.
  assert.doesNotMatch(html.slice(main, main + 80), /type="module"|\bdefer\b/);
});
