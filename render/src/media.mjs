// com.lopecode.media lookup, and the social-card tags derived from it.
//
// A media record's rkey IS its poster blob's CID, and a bundle's
// `coverImage` is that same blob. So the bundle record alone locates the
// media record — one getRecord against a key we already hold, and no
// com.lopecode.bundle lexicon change.

import { escapeAttr, headOf } from "./page.mjs";

const MEDIA_PROXY = "https://images.lopecode.com";

// Why the proxy and not `${pds}/xrpc/com.atproto.sync.getBlob?…`: a
// getBlob URL names whichever PDS the author was on when the bundle was
// baked, and atproto supports PDS migration. The baked URL then points
// at a host that no longer holds the repo, and a social card that has
// already been scraped never recovers. The proxy resolves DID→PDS per
// request, so the URL outlives the move.
//
// did and cid are left unescaped on purpose: the DID comes from the
// `did-<method>-<id>` subdomain ([a-z]+ / [a-z0-9]+) and the CID is
// base32 CIDv1, both already inside the path charset. Percent-encoding
// the DID's colons would not match the proxy's own route.

/**
 * @param {string} did
 * @param {string} cid  poster blob CID == the media record's rkey
 * @returns {string}
 */
export const mediaImageUrl = (did, cid) => `${MEDIA_PROXY}/${did}/${cid}`;

/**
 * The video blob of the media record keyed by the SAME poster CID —
 * `/video` selects it, so the proxy still authorises with one O(1)
 * getRecord against the rkey in the URL.
 *
 * @param {string} did
 * @param {string} cid  poster blob CID == the media record's rkey
 * @returns {string}
 */
export const mediaVideoUrl = (did, cid) => `${mediaImageUrl(did, cid)}/video`;

/** @param {any} blob @returns {string | undefined} */
const blobCid = blob => blob?.ref?.$link ?? blob?.cid ?? undefined;

/**
 * Fetch the com.lopecode.media record for a poster CID. Never throws:
 * every failure — a missing record (getRecord answers RecordNotFound
 * with a 4xx), an unreachable PDS, a malformed body — is null, i.e.
 * "no video, no alt". og:image does not depend on this call, so a
 * degraded lookup costs the page nothing.
 *
 * @param {string} pds
 * @param {string} did
 * @param {string} cid  poster blob CID == the media record's rkey
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<any | null>} the record's `value`, or null
 */
export async function fetchMediaRecord(pds, did, cid, fetchImpl = fetch) {
  const url =
    `${pds}/xrpc/com.atproto.repo.getRecord` +
    `?repo=${encodeURIComponent(did)}&collection=com.lopecode.media&rkey=${encodeURIComponent(cid)}`;
  try {
    const r = await fetchImpl(url);
    if (!r.ok) return null;
    const body = await r.json();
    return body?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * The head tags the vendored exporter-3 cannot emit. It only knows
 * og:title/og:type/description/og:description/og:image, so these are
 * injected post-hoc by the Worker instead (see worker.ts) — resyncing
 * the vendored copy is out of scope.
 *
 * Everything degrades on the cover image: no coverImage means no media
 * record to look up, hence no og:video and no alt, and twitter:card
 * drops to `summary` (the card X renders when there is no large image).
 *
 * @param {{did: string, coverCid?: string, media?: any}} args
 * @returns {string[]}
 */
export function socialMetaTags({ did, coverCid, media }) {
  const tags = [];
  const alt = coverCid ? media?.alt : undefined;
  if (alt) tags.push(`<meta property="og:image:alt" content="${escapeAttr(alt)}">`);

  const videoCid = coverCid ? blobCid(media?.video) : undefined;
  if (videoCid) {
    tags.push(`<meta property="og:video" content="${escapeAttr(mediaVideoUrl(did, coverCid))}">`);
    const mime = media?.video?.mimeType;
    if (mime) tags.push(`<meta property="og:video:type" content="${escapeAttr(mime)}">`);
  }

  // No twitter:* tag at all today, and without a card declaration X and
  // several other unfurlers refuse to show the image at any size.
  tags.push(
    `<meta name="twitter:card" content="${coverCid ? "summary_large_image" : "summary"}">`
  );
  return tags;
}

/**
 * `socialMetaTags`, minus whatever the export already baked into its own
 * <head>. Checked against the head only — the bundle carries
 * @tomlarkworthy/exporter-3's source, whose head template mentions og:*
 * inside a `<script type="text/plain">` block, so a whole-document
 * `includes` false-positives.
 *
 * @param {string} html
 * @param {{did: string, coverCid?: string, media?: any}} args
 * @returns {string[]}
 */
export function socialMetaTagsFor(html, args) {
  const head = headOf(html);
  return socialMetaTags(args).filter(tag => {
    const key = tag.match(/(?:property|name)="([^"]+)"/)?.[1];
    return !(key && head.includes(`="${key}"`));
  });
}
