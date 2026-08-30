// Media proxy Worker: serves the blobs of a com.lopecode.media record from
// the author's PDS at
//
//   GET images.lopecode.com/<did>/<rkey>          → the poster bytes
//   GET images.lopecode.com/<did>/<rkey>/video    → the video bytes
//
// Reached via service binding from the apex Worker
// (images.lopecode.com → IMAGES).
//
// It is not a proxy for arbitrary blobs: bytes are served only when
// com.atproto.repo.getRecord returns a com.lopecode.media record whose
// poster CID is the rkey in the URL (see decideBlob). That check is what
// stops this being an open relay for anything in anyone's repo.
//
// DID → PDS is resolved per request, so a URL keeps working after the
// author migrates PDS. We never read cdn.bsky.app: serving from the
// author's own PDS works for any PDS regardless of Bluesky-network
// membership, and Cloudflare's edge cache is the CDN.

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

// Bump to invalidate every cached record and blob: it is a path segment in
// the caches.default keys, so bumping sends the next fetches upstream.
const CACHE_VERSION = "v1";

// Records are re-checked this often. Short, because it is the authorisation
// answer: a deleted record stops being servable within a minute, even though
// the poster response itself carries an immutable far-future cache-control.
const RECORD_TTL = 60;

/** PDS or DID resolution is broken → 502. */
class UpstreamError extends Error {}
/** There is legitimately nothing here → 404. */
class NotFoundError extends Error {}

function textResponse(body: string, status: number, headers: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers }
  });
}

// Deliberately says nothing about why. "no record", "wrong PDS" and "blob
// too large" are all the same answer to a caller who is not the author.
// Cached briefly so a missing record cannot be used to hammer a PDS.
const notFound = () =>
  textResponse("not found\n", 404, { "cache-control": `public, max-age=${RECORD_TTL}` });

const upstreamFailed = () =>
  textResponse("upstream unavailable\n", 502, { "cache-control": "no-store" });

async function fetchJson(url: string): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url);
    if (!r.ok) r = await fetch(url); // one retry: PDS hiccups are common
  } catch {
    throw new UpstreamError("network");
  }
  if (r.status >= 400 && r.status < 500) throw new NotFoundError(String(r.status));
  if (!r.ok) throw new UpstreamError(String(r.status));
  try {
    return await r.json();
  } catch {
    throw new UpstreamError("bad json");
  }
}

async function resolvePds(did: string): Promise<string> {
  const docUrl = didDocUrl(did);
  if (!docUrl) throw new NotFoundError("did");
  const cacheKey = new Request(
    `https://lopecode-media.invalid/pds/${CACHE_VERSION}/${encodeURIComponent(did)}`
  );
  const cached = await caches.default.match(cacheKey);
  if (cached) return await cached.text();

  const pds = pdsOf(await fetchJson(docUrl));
  if (!pds) throw new NotFoundError("no pds");
  await caches.default.put(
    cacheKey,
    new Response(pds, {
      headers: { "cache-control": "public, max-age=300", "content-type": "text/plain; charset=utf-8" }
    })
  );
  return pds;
}

// The getRecord lookup, cached on did+rkey. An empty body is a cached
// negative — without it a request for a record that does not exist is a
// free PDS round-trip for whoever asks.
async function fetchRecord(pds: string, did: string, rkey: string): Promise<any> {
  const cacheKey = new Request(
    `https://lopecode-media.invalid/record/${CACHE_VERSION}/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`
  );
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const text = await cached.text();
    return text ? JSON.parse(text) : null;
  }

  let record: any = null;
  try {
    record = await fetchJson(getRecordUrl(pds, did, rkey));
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  await caches.default.put(
    cacheKey,
    new Response(record ? JSON.stringify(record) : "", {
      headers: { "cache-control": `public, max-age=${RECORD_TTL}`, "content-type": "application/json" }
    })
  );
  return record;
}

// Blob bytes, cached under the CID. CIDs are content-addressed, so the key
// is stable across DIDs and records — and for the poster the CID *is* the
// rkey, so this is the did+rkey key by another name. The cached entry holds
// bytes only; the content-type served to the client always comes from the
// record, never from this cache or from the upstream response.
async function fetchBlob(pds: string, did: string, cid: string): Promise<Uint8Array> {
  const cacheKey = new Request(`https://lopecode-media.invalid/blob/${CACHE_VERSION}/${encodeURIComponent(cid)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  let r: Response;
  try {
    r = await fetch(getBlobUrl(pds, did, cid));
    if (!r.ok) r = await fetch(getBlobUrl(pds, did, cid));
  } catch {
    throw new UpstreamError("network");
  }
  if (r.status >= 400 && r.status < 500) throw new NotFoundError(String(r.status));
  if (!r.ok) throw new UpstreamError(String(r.status));

  const bytes = new Uint8Array(await r.arrayBuffer());
  await caches.default.put(
    cacheKey,
    new Response(bytes, {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": "application/octet-stream"
      }
    })
  );
  return bytes;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (!isAllowedMethod(request.method)) {
      return textResponse("method not allowed\n", 405, { allow: "GET, HEAD", "cache-control": "no-store" });
    }

    const target = parseMediaPath(new URL(request.url).pathname);
    if (!target) return notFound();

    let pds: string;
    let record: any;
    try {
      pds = await resolvePds(target.did);
      record = await fetchRecord(pds, target.did, target.rkey);
    } catch (e) {
      return e instanceof NotFoundError ? notFound() : upstreamFailed();
    }

    const decision = decideBlob(record, target.rkey, target.video);
    if (!decision.ok) return notFound();

    const headers = new Headers({
      // From the record's mimeType, never sniffed off the upstream response.
      "content-type": decision.mimeType,
      // Explicitly inline: render's ?file= endpoint sets `attachment`, which
      // is exactly why it cannot serve an og:image.
      "content-disposition": "inline",
      "cache-control":
        decision.kind === "poster"
          ? "public, max-age=31536000, immutable"
          : "public, max-age=86400",
      // The CID. Content-addressed, so it is a genuinely strong validator.
      // The video gets its own CID rather than the rkey: the rkey is the
      // *poster* CID, so a record whose video changed under an unchanged
      // poster would otherwise serve stale bytes forever.
      etag: `"${decision.cid}"`,
      "x-content-type-options": "nosniff"
    });

    if (request.headers.get("if-none-match") === `"${decision.cid}"`) {
      return new Response(null, { status: 304, headers });
    }

    // HEAD answers from the record's declared size and skips the blob fetch;
    // the size is part of the content-addressed blob ref, so it agrees with
    // the bytes a GET would return.
    if (request.method === "HEAD") {
      headers.set("content-length", String(decision.size));
      return new Response(null, { status: 200, headers });
    }

    let bytes: Uint8Array;
    try {
      bytes = await fetchBlob(pds, target.did, decision.cid);
    } catch (e) {
      return e instanceof NotFoundError ? notFound() : upstreamFailed();
    }
    // Last enforcement point: the lexicon cap applies to the bytes actually
    // going out, not just to the size the record claimed.
    if (bytes.byteLength > LIMITS[decision.kind].maxSize) return notFound();

    headers.set("content-length", String(bytes.byteLength));
    return new Response(bytes, { status: 200, headers });
  }
};
