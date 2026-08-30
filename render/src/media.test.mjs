// node --test src/media.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchMediaRecord,
  mediaImageUrl,
  mediaVideoUrl,
  socialMetaTags,
  socialMetaTagsFor
} from "./media.mjs";

const DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
const POSTER = "bafkreiadi6xnwnvcwqi7hbb2zzqfxvyzabtvqjjjfnaqdrqcecebeaaaaa";
const VIDEO = "bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const blob = (cid, mimeType) => ({ $type: "blob", ref: { $link: cid }, mimeType, size: 1234 });

const okJson = value => async () => ({ ok: true, json: async () => value });

// ---- URL construction ----

test("the proxy URL is /<did>/<cid>, colons left as path chars", () => {
  assert.equal(mediaImageUrl(DID, POSTER), `https://images.lopecode.com/${DID}/${POSTER}`);
  assert.doesNotMatch(mediaImageUrl(DID, POSTER), /%3A/);
});

test("the video URL is the poster URL plus /video (same rkey)", () => {
  assert.equal(mediaVideoUrl(DID, POSTER), `https://images.lopecode.com/${DID}/${POSTER}/video`);
});

// ---- fetchMediaRecord ----

test("fetchMediaRecord asks getRecord for com.lopecode.media at the poster CID", async () => {
  const seen = [];
  const fake = async url => {
    seen.push(url);
    return { ok: true, json: async () => ({ uri: "at://x", value: { poster: blob(POSTER, "image/webp") } }) };
  };
  const value = await fetchMediaRecord("https://pds.example", DID, POSTER, fake);
  assert.deepEqual(value, { poster: blob(POSTER, "image/webp") });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^https:\/\/pds\.example\/xrpc\/com\.atproto\.repo\.getRecord\?/);
  assert.match(seen[0], /collection=com\.lopecode\.media/);
  assert.match(seen[0], /repo=did%3Aplc%3Aj7nm3lrd5h7fm3sfhcv3lhfv/);
  assert.match(seen[0], new RegExp(`rkey=${POSTER}`));
});

test("a missing record (getRecord 4xx) is null, not a throw", async () => {
  const fake = async () => ({ ok: false, status: 400, json: async () => ({ error: "RecordNotFound" }) });
  assert.equal(await fetchMediaRecord("https://pds.example", DID, POSTER, fake), null);
});

test("a throwing lookup is null, not a throw", async () => {
  const fake = async () => { throw new Error("connect ECONNREFUSED"); };
  assert.equal(await fetchMediaRecord("https://pds.example", DID, POSTER, fake), null);
});

test("a malformed body is null", async () => {
  const bad = async () => ({ ok: true, json: async () => { throw new SyntaxError("not json"); } });
  assert.equal(await fetchMediaRecord("https://pds.example", DID, POSTER, bad), null);
  assert.equal(await fetchMediaRecord("https://pds.example", DID, POSTER, okJson({})), null);
});

// ---- tag emission ----

test("a media record with a video emits og:video, its type, and the alt", () => {
  const media = { poster: blob(POSTER, "image/webp"), video: blob(VIDEO, "video/mp4"), alt: "A spinning card" };
  const tags = socialMetaTags({ did: DID, coverCid: POSTER, media }).join("\n");
  assert.match(tags, new RegExp(`<meta property="og:video" content="https://images\\.lopecode\\.com/${DID}/${POSTER}/video">`));
  assert.match(tags, /<meta property="og:video:type" content="video\/mp4">/);
  assert.match(tags, /<meta property="og:image:alt" content="A spinning card">/);
  assert.match(tags, /<meta name="twitter:card" content="summary_large_image">/);
});

// The video URL is keyed by the POSTER cid — that is the media record's
// rkey, which is what the proxy authorises against.
test("og:video names the poster CID, never the video blob's own CID", () => {
  const media = { video: blob(VIDEO, "video/mp4") };
  const tags = socialMetaTags({ did: DID, coverCid: POSTER, media }).join("\n");
  assert.match(tags, new RegExp(`/${POSTER}/video`));
  assert.doesNotMatch(tags, new RegExp(VIDEO));
});

test("a record without a video emits no og:video, keeps the alt and the large card", () => {
  const media = { poster: blob(POSTER, "image/webp"), alt: "Still only" };
  const tags = socialMetaTags({ did: DID, coverCid: POSTER, media }).join("\n");
  assert.doesNotMatch(tags, /og:video/);
  assert.match(tags, /<meta property="og:image:alt" content="Still only">/);
  assert.match(tags, /<meta name="twitter:card" content="summary_large_image">/);
});

test("a video blob with no mimeType still emits og:video, minus the type", () => {
  const media = { video: { ref: { $link: VIDEO } } };
  const tags = socialMetaTags({ did: DID, coverCid: POSTER, media }).join("\n");
  assert.match(tags, /og:video"/);
  assert.doesNotMatch(tags, /og:video:type/);
});

test("no media record at all: og:image still stands, no video, no alt", () => {
  const tags = socialMetaTags({ did: DID, coverCid: POSTER, media: null }).join("\n");
  assert.doesNotMatch(tags, /og:video/);
  assert.doesNotMatch(tags, /og:image:alt/);
  assert.match(tags, /<meta name="twitter:card" content="summary_large_image">/);
});

test("no coverImage: summary card, and no media-derived tag can leak through", () => {
  const media = { video: blob(VIDEO, "video/mp4"), alt: "orphan" };
  const tags = socialMetaTags({ did: DID, coverCid: undefined, media }).join("\n");
  assert.equal(tags, '<meta name="twitter:card" content="summary">');
});

test("alt and mimeType are attribute-escaped", () => {
  const media = { alt: 'He said "<hi>" & left', video: blob(VIDEO, 'video/mp4";x="1') };
  const tags = socialMetaTags({ did: DID, coverCid: POSTER, media }).join("\n");
  assert.match(tags, /content="He said &quot;&lt;hi>&quot; &amp; left"/);
  assert.match(tags, /content="video\/mp4&quot;;x=&quot;1"/);
});

// ---- idempotency against the export's own head ----

const doc = head =>
  `<html><head>${head}</head><body><script type="text/plain">` +
  `<meta property="og:image" content="\${x}"><meta name="twitter:card" content="summary">` +
  `</script></body></html>`;

test("a tag the export already baked into its head is not injected twice", () => {
  const html = doc('<meta name="twitter:card" content="summary_large_image">');
  const tags = socialMetaTagsFor(html, { did: DID, coverCid: POSTER, media: null });
  assert.deepEqual(tags, []);
});

test("an identical-looking tag inside a text/plain block does NOT suppress injection", () => {
  const tags = socialMetaTagsFor(doc(""), { did: DID, coverCid: POSTER, media: null });
  assert.deepEqual(tags, ['<meta name="twitter:card" content="summary_large_image">']);
});

test("suppression is per tag, not all-or-nothing", () => {
  const html = doc('<meta property="og:image:alt" content="baked">');
  const media = { video: blob(VIDEO, "video/mp4"), alt: "from the record" };
  const tags = socialMetaTagsFor(html, { did: DID, coverCid: POSTER, media });
  assert.equal(tags.length, 3);
  assert.doesNotMatch(tags.join("\n"), /og:image:alt/);
  assert.match(tags.join("\n"), /og:video"/);
  assert.match(tags.join("\n"), /twitter:card/);
});

// ---- the whole degradation chain, as the Worker runs it ----

test("a failing lookup degrades to the no-media page, never to an error", async () => {
  const dead = async () => { throw new Error("PDS down"); };
  const media = await fetchMediaRecord("https://pds.example", DID, POSTER, dead);
  const tags = socialMetaTagsFor(doc(""), { did: DID, coverCid: POSTER, media });
  // og:image comes from renderBundle's `image` option and is untouched
  // by the lookup; only the video/alt extras are lost.
  assert.deepEqual(tags, ['<meta name="twitter:card" content="summary_large_image">']);
});
