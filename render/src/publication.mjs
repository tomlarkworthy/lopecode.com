// Which `site.standard.publication` record does this host represent?
//
// standard.site verification is: fetch `<publication.url>/.well-known/
// site.standard.publication` and check the AT-URI it returns names a
// publication whose `url` is that same origin. We host one publication
// per author at `did-<method>-<id>.lopecode.com`, so the answer is a
// per-DID lookup against the author's PDS, not a constant.
//
// The lexicon at @standard.site is `key: tid`, so `self` is an illegal
// rkey — an early at-write wrote one anyway and it is still live. We
// answer with the newest TID-keyed record and only fall back to `self`
// when the author has no TID record at all.

const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

export const isTid = rkey => TID_RE.test(rkey);

const rkeyOf = uri => uri.slice(uri.lastIndexOf("/") + 1);

// standard.site declares `url` has no trailing slash; tolerate one anyway.
const normUrl = u => (typeof u === "string" ? u.trim().replace(/\/+$/, "").toLowerCase() : "");

/**
 * Pick the publication AT-URI for `https://<host>` out of a listRecords page.
 * Returns null when the author has no publication for this host.
 *
 * @param {Array<{uri: string, value?: {url?: string}}>} records
 * @param {string} host
 */
export function selectPublicationUri(records, host) {
  const want = normUrl(`https://${host}`);
  const mine = (records ?? []).filter(r => r?.uri && normUrl(r.value?.url) === want);

  // TIDs are lexicographically ordered by mint time, so max() is newest.
  const tids = mine.filter(r => isTid(rkeyOf(r.uri))).sort((a, b) => (a.uri < b.uri ? 1 : -1));
  if (tids.length) return tids[0].uri;

  const self = mine.find(r => rkeyOf(r.uri) === "self");
  return self ? self.uri : null;
}

/**
 * Fetch the author's publication records and select the one for `host`.
 * Throws on an unreachable PDS; returns null when the author has none.
 *
 * @param {string} pds
 * @param {string} did
 * @param {string} host
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchPublicationUri(pds, did, host, fetchImpl = fetch) {
  const url =
    `${pds}/xrpc/com.atproto.repo.listRecords` +
    `?repo=${encodeURIComponent(did)}&collection=site.standard.publication&limit=100`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`listRecords site.standard.publication ${r.status}`);
  const body = await r.json();
  return selectPublicationUri(body?.records, host);
}
