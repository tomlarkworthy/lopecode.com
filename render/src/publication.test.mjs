// node --test src/publication.test.mjs
//
// Fixtures are the live shape as of 2026-08-30: the author has two
// publication records with identical values, one at the illegal rkey
// `self` and one at a TID.

import test from "node:test";
import assert from "node:assert/strict";
import { selectPublicationUri, fetchPublicationUri, isTid } from "./publication.mjs";

const HOST = "did-plc-j7nm3lrd5h7fm3sfhcv3lhfv.lopecode.com";
const DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
const URL_ = `https://${HOST}`;

const rec = (rkey, url = URL_) => ({
  uri: `at://${DID}/site.standard.publication/${rkey}`,
  value: { $type: "site.standard.publication", url, name: "@larkworthy.bsky.social" }
});

test("prefers the TID record over self", () => {
  assert.equal(
    selectPublicationUri([rec("self"), rec("3mndgo4hhre22")], HOST),
    `at://${DID}/site.standard.publication/3mndgo4hhre22`
  );
});

test("picks the newest TID when several", () => {
  const got = selectPublicationUri([rec("3mndgo4hhre22"), rec("3lzaaaaaaaa22"), rec("self")], HOST);
  assert.equal(got, `at://${DID}/site.standard.publication/3mndgo4hhre22`);
});

test("falls back to self when no TID record exists", () => {
  assert.equal(
    selectPublicationUri([rec("self")], HOST),
    `at://${DID}/site.standard.publication/self`
  );
});

test("ignores records whose url is another host", () => {
  assert.equal(selectPublicationUri([rec("3mndgo4hhre22", "https://example.com")], HOST), null);
});

test("tolerates a trailing slash and case on the declared url", () => {
  assert.equal(
    selectPublicationUri([rec("3mndgo4hhre22", `${URL_.toUpperCase()}/`)], HOST),
    `at://${DID}/site.standard.publication/3mndgo4hhre22`
  );
});

test("no records at all is null, not a guessed self", () => {
  assert.equal(selectPublicationUri([], HOST), null);
  assert.equal(selectPublicationUri(undefined, HOST), null);
});

test("isTid rejects self and accepts a minted TID", () => {
  assert.equal(isTid("self"), false);
  assert.equal(isTid("3mndgo4hhre22"), true);
  assert.equal(isTid("3mndgo4hhre2"), false); // 12 chars
});

test("fetchPublicationUri queries listRecords and selects", async () => {
  const seen = [];
  const fakeFetch = async url => {
    seen.push(url);
    return {
      ok: true,
      json: async () => ({ records: [rec("self"), rec("3mndgo4hhre22")] })
    };
  };
  const uri = await fetchPublicationUri("https://pds.example", DID, HOST, fakeFetch);
  assert.equal(uri, `at://${DID}/site.standard.publication/3mndgo4hhre22`);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^https:\/\/pds\.example\/xrpc\/com\.atproto\.repo\.listRecords\?/);
  assert.match(seen[0], /collection=site\.standard\.publication/);
  assert.match(seen[0], /repo=did%3Aplc%3Aj7nm3lrd5h7fm3sfhcv3lhfv/);
});

test("fetchPublicationUri throws on an upstream error", async () => {
  const fakeFetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(
    () => fetchPublicationUri("https://pds.example", DID, HOST, fakeFetch),
    /listRecords site\.standard\.publication 502/
  );
});
