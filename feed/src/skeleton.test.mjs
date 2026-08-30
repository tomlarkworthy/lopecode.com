// node --test src/skeleton.test.mjs
//
// Fixture shape is contrail's com.lopecode.bundle.listRecords page, which
// carries the whole indexed record under `value` (checked live 2026-08-30:
// 11 bundles, one with a bskyPostUri).

import test from "node:test";
import assert from "node:assert/strict";
import { skeletonItems } from "./skeleton.mjs";

const DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
const POST = `at://${DID}/app.bsky.feed.post/3mnehmlq3sd2d`;

const bundle = (rkey, bskyPostUri) => ({
  uri: `at://${DID}/com.lopecode.bundle/${rkey}`,
  cid: "bafy",
  did: DID,
  rkey,
  value: { $type: "com.lopecode.bundle", createdAt: "2026-06-03T06:18:24.731Z", ...(bskyPostUri ? { bskyPostUri } : {}) }
});

test("emits the recorded post URI", () => {
  assert.deepEqual(skeletonItems([bundle("atproto", POST)]), [{ post: POST }]);
});

test("skips bundles with no companion post", () => {
  const items = skeletonItems([bundle("lopefeed"), bundle("atproto", POST), bundle("ledger")]);
  assert.deepEqual(items, [{ post: POST }]);
});

test("never derives a post URI from the bundle rkey", () => {
  const items = skeletonItems([bundle("atproto")]);
  assert.deepEqual(items, []);
});

test("rejects a URI that is not an app.bsky.feed.post", () => {
  assert.deepEqual(skeletonItems([bundle("x", `at://${DID}/com.lopecode.bundle/x`)]), []);
  assert.deepEqual(skeletonItems([bundle("x", "https://bsky.app/profile/a/post/b")]), []);
});

test("tolerates a missing or empty records array", () => {
  assert.deepEqual(skeletonItems([]), []);
  assert.deepEqual(skeletonItems(undefined), []);
  assert.deepEqual(skeletonItems([{}, { value: null }]), []);
});

test("preserves contrail's order", () => {
  const a = `at://${DID}/app.bsky.feed.post/3aaaaaaaaaaaa`;
  const b = `at://${DID}/app.bsky.feed.post/3bbbbbbbbbbbb`;
  assert.deepEqual(skeletonItems([bundle("x", b), bundle("y", a)]), [{ post: b }, { post: a }]);
});
