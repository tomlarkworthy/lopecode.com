// node --test src/media.test.mjs
//
// Fixture shape is a com.atproto.repo.getRecord response for
// com.lopecode.media. The rkey is the poster blob's CID, which is what makes
// authorisation one O(1) lookup against the key already in the URL.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMediaPath,
  isAllowedMethod,
  decideBlob,
  didDocUrl,
  pdsOf,
  getRecordUrl,
  getBlobUrl,
  LIMITS
} from "./media.mjs";

const DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
const POSTER_CID = "bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopq";
const VIDEO_CID = "bafkreizzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

const blob = (cid, mimeType, size) => ({ $type: "blob", ref: { $link: cid }, mimeType, size });

const record = (value) => ({
  uri: `at://${DID}/com.lopecode.media/${POSTER_CID}`,
  cid: "bafyrecord",
  value: { $type: "com.lopecode.media", createdAt: "2026-08-30T00:00:00.000Z", ...value }
});

const poster = () => record({ poster: blob(POSTER_CID, "image/webp", 51234) });
const withVideo = () =>
  record({
    poster: blob(POSTER_CID, "image/webp", 51234),
    video: blob(VIDEO_CID, "video/mp4", 252000)
  });

// ---- URL parsing ----------------------------------------------------------

test("parses the poster path", () => {
  assert.deepEqual(parseMediaPath(`/${DID}/${POSTER_CID}`), {
    did: DID,
    rkey: POSTER_CID,
    video: false
  });
});

test("parses the video path", () => {
  assert.deepEqual(parseMediaPath(`/${DID}/${POSTER_CID}/video`), {
    did: DID,
    rkey: POSTER_CID,
    video: true
  });
});

test("url-decodes the did", () => {
  const encoded = encodeURIComponent(DID);
  assert.notEqual(encoded, DID);
  assert.equal(parseMediaPath(`/${encoded}/${POSTER_CID}`)?.did, DID);
});

test("accepts did:web", () => {
  assert.equal(
    parseMediaPath(`/did%3Aweb%3Aexample.com/${POSTER_CID}`)?.did,
    "did:web:example.com"
  );
});

test("rejects a missing rkey, a bare did, and the root", () => {
  assert.equal(parseMediaPath(`/${DID}`), null);
  assert.equal(parseMediaPath(`/${DID}/`), null);
  assert.equal(parseMediaPath("/"), null);
  assert.equal(parseMediaPath(""), null);
});

test("rejects trailing junk after the rkey", () => {
  assert.equal(parseMediaPath(`/${DID}/${POSTER_CID}/`), null);
  assert.equal(parseMediaPath(`/${DID}/${POSTER_CID}/poster`), null);
  assert.equal(parseMediaPath(`/${DID}/${POSTER_CID}/video/x`), null);
  assert.equal(parseMediaPath(`/${DID}/${POSTER_CID}/VIDEO`), null);
});

test("rejects a non-did first segment and malformed encoding", () => {
  assert.equal(parseMediaPath(`/notadid/${POSTER_CID}`), null);
  assert.equal(parseMediaPath(`/did:key:zabc/${POSTER_CID}`), null);
  assert.equal(parseMediaPath(`/%E0%A4%A/${POSTER_CID}`), null);
  assert.equal(parseMediaPath(`/${DID}/rk ey`), null);
});

test("only GET and HEAD are allowed", () => {
  assert.equal(isAllowedMethod("GET"), true);
  assert.equal(isAllowedMethod("HEAD"), true);
  for (const m of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH", "get"]) {
    assert.equal(isAllowedMethod(m), false, m);
  }
});

// ---- authorisation --------------------------------------------------------

test("serves the poster on the happy path", () => {
  assert.deepEqual(decideBlob(poster(), POSTER_CID, false), {
    ok: true,
    kind: "poster",
    cid: POSTER_CID,
    mimeType: "image/webp",
    size: 51234
  });
});

test("serves the video on the happy path", () => {
  assert.deepEqual(decideBlob(withVideo(), POSTER_CID, true), {
    ok: true,
    kind: "video",
    cid: VIDEO_CID,
    mimeType: "video/mp4",
    size: 252000
  });
});

test("refuses when there is no record", () => {
  for (const r of [null, undefined, {}, { value: null }, { value: "nope" }]) {
    assert.equal(decideBlob(r, POSTER_CID, false).ok, false);
  }
  assert.equal(decideBlob(null, POSTER_CID, false).reason, "no-record");
});

test("refuses when poster.ref disagrees with the rkey", () => {
  const d = decideBlob(poster(), VIDEO_CID, false);
  assert.equal(d.ok, false);
  assert.equal(d.reason, "poster-mismatch");
});

test("a key/blob disagreement blocks the video path too", () => {
  // The rkey is the only thing binding this URL to this record; if it does
  // not name the record's own poster, nothing in the record is servable.
  assert.equal(decideBlob(withVideo(), VIDEO_CID, true).ok, false);
});

test("refuses a record with no poster blob", () => {
  assert.equal(decideBlob(record({}), POSTER_CID, false).ok, false);
  assert.equal(decideBlob(record({ poster: { ref: { $link: POSTER_CID } } }), POSTER_CID, false).ok, false);
});

test("refuses the video path when the record has no video", () => {
  const d = decideBlob(poster(), POSTER_CID, true);
  assert.equal(d.ok, false);
  assert.equal(d.reason, "no-video");
});

test("refuses a poster that is not an image or is over 1MB", () => {
  const wrongMime = record({ poster: blob(POSTER_CID, "text/html", 10) });
  assert.equal(decideBlob(wrongMime, POSTER_CID, false).reason, "mime");

  const tooBig = record({ poster: blob(POSTER_CID, "image/png", LIMITS.poster.maxSize + 1) });
  assert.equal(decideBlob(tooBig, POSTER_CID, false).reason, "size");

  const atCap = record({ poster: blob(POSTER_CID, "image/png", LIMITS.poster.maxSize) });
  assert.equal(decideBlob(atCap, POSTER_CID, false).ok, true);
});

test("refuses a video that is not video/* or is over 5MB", () => {
  const wrongMime = record({
    poster: blob(POSTER_CID, "image/webp", 10),
    video: blob(VIDEO_CID, "application/octet-stream", 10)
  });
  assert.equal(decideBlob(wrongMime, POSTER_CID, true).reason, "mime");

  const tooBig = record({
    poster: blob(POSTER_CID, "image/webp", 10),
    video: blob(VIDEO_CID, "video/mp4", LIMITS.video.maxSize + 1)
  });
  assert.equal(decideBlob(tooBig, POSTER_CID, true).reason, "size");
});

test("a poster over the video cap is still refused on the poster path", () => {
  // The two caps are different; the poster must not be judged by the video's.
  const r = record({ poster: blob(POSTER_CID, "image/png", 2_000_000) });
  assert.equal(decideBlob(r, POSTER_CID, false).reason, "size");
});

test("mime matching is case-insensitive and prefix-anchored", () => {
  assert.equal(decideBlob(record({ poster: blob(POSTER_CID, "IMAGE/PNG", 1) }), POSTER_CID, false).ok, true);
  assert.equal(
    decideBlob(record({ poster: blob(POSTER_CID, "x-image/png", 1) }), POSTER_CID, false).ok,
    false
  );
});

// ---- DID resolution -------------------------------------------------------

test("did:plc resolves through plc.directory", () => {
  assert.equal(didDocUrl(DID), `https://plc.directory/${DID}`);
});

test("did:web resolves through the domain's did.json", () => {
  assert.equal(didDocUrl("did:web:example.com"), "https://example.com/.well-known/did.json");
  assert.equal(didDocUrl("did:web:example.com:u:alice"), "https://example.com/u/alice/did.json");
  assert.equal(didDocUrl("did:web:example.com%3A8443"), "https://example.com:8443/.well-known/did.json");
  assert.equal(didDocUrl("did:web:not a host"), null);
  assert.equal(didDocUrl("did:key:zabc"), null);
});

test("pdsOf picks the atproto PDS service, https only", () => {
  const doc = {
    service: [
      { id: "#other", type: "Thing", serviceEndpoint: "https://nope.example" },
      { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }
    ]
  };
  assert.equal(pdsOf(doc), "https://pds.example");
  assert.equal(pdsOf({ service: [] }), null);
  assert.equal(pdsOf({}), null);
  assert.equal(
    pdsOf({ service: [{ id: "#atproto_pds", serviceEndpoint: "http://pds.example" }] }),
    null
  );
});

// ---- the lookup the Worker performs, against a mocked fetch ---------------

test("authorisation runs off exactly one getRecord against the author's PDS", async () => {
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => withVideo() };
  };

  const pds = "https://pds.example";
  const target = parseMediaPath(`/${DID}/${POSTER_CID}/video`);
  const r = await fetchMock(getRecordUrl(pds, target.did, target.rkey));
  const decision = decideBlob(await r.json(), target.rkey, target.video);

  assert.equal(decision.ok, true);
  assert.deepEqual(calls, [
    `https://pds.example/xrpc/com.atproto.repo.getRecord` +
      `?repo=did%3Aplc%3Aj7nm3lrd5h7fm3sfhcv3lhfv&collection=com.lopecode.media&rkey=${POSTER_CID}`
  ]);
  assert.equal(
    getBlobUrl(pds, DID, decision.cid),
    `https://pds.example/xrpc/com.atproto.sync.getBlob` +
      `?did=did%3Aplc%3Aj7nm3lrd5h7fm3sfhcv3lhfv&cid=${VIDEO_CID}`
  );
  // Never cdn.bsky.app: the bytes come from the author's own PDS.
  assert.ok(!calls.some(u => u.includes("cdn.bsky.app")));
});

test("a getRecord that 400s (RecordNotFound) is a refusal, not a serve", async () => {
  const fetchMock = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "RecordNotFound", message: "Could not locate record" })
  });
  const r = await fetchMock();
  // worker.ts turns a 4xx into a null record; the decision must refuse it.
  const decision = decideBlob(r.ok ? await r.json() : null, POSTER_CID, false);
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "no-record");
});
