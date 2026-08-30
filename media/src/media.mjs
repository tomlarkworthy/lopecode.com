// Pure logic for the media proxy: URL parsing, the authorisation decision
// over a com.atproto.repo.getRecord response, and DID-document location.
// No I/O — worker.ts does the fetching, so all of this is unit-testable
// without a network or a Workers runtime.

export const MEDIA_COLLECTION = "com.lopecode.media";

// Copied from the lexicon (contrail/lexicons/pulled/com/lopecode/media.json).
// Re-checked here rather than trusted: the record was written by the author's
// own PDS, and a PDS is not obliged to have enforced our lexicon.
export const LIMITS = {
  poster: { prefix: "image/", maxSize: 1000000 },
  video: { prefix: "video/", maxSize: 5000000 }
};

const DID_RE = /^did:(plc|web):[A-Za-z0-9._:%-]{1,300}$/;
// atproto record-key charset. The rkey here is a base32 CIDv1, which is a
// strict subset of it; we don't demand CID shape so a future CID codec
// cannot lock itself out.
const RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;

/**
 * `/<did>/<rkey>` or `/<did>/<rkey>/video`. Anything else — a trailing
 * slash, a third segment that is not `video`, a malformed DID — is null,
 * which the Worker turns into a 404.
 * @param {string} pathname
 * @returns {{did: string, rkey: string, video: boolean} | null}
 */
export function parseMediaPath(pathname) {
  const parts = String(pathname).split("/");
  if (parts[0] !== "" || parts.length < 3 || parts.length > 4) return null;
  if (parts.length === 4 && parts[3] !== "video") return null;

  let did, rkey;
  try {
    did = decodeURIComponent(parts[1]);
    rkey = decodeURIComponent(parts[2]);
  } catch {
    return null; // malformed percent-encoding
  }
  if (!DID_RE.test(did) || !RKEY_RE.test(rkey)) return null;
  return { did, rkey, video: parts.length === 4 };
}

/** @param {string} method */
export function isAllowedMethod(method) {
  return method === "GET" || method === "HEAD";
}

/**
 * Normalise an atproto blob to the three fields we need, or null when it is
 * not a usable blob. Accepts both the JSON form (`ref: {$link}`) and a bare
 * string ref.
 * @param {any} b
 * @returns {{cid: string, mimeType: string, size: number} | null}
 */
function blobOf(b) {
  if (!b || typeof b !== "object") return null;
  const ref = b.ref;
  const cid =
    typeof ref === "string" ? ref
    : ref && typeof ref === "object" && typeof ref.$link === "string" ? ref.$link
    : null;
  if (!cid || !RKEY_RE.test(cid)) return null;
  if (typeof b.mimeType !== "string" || b.mimeType === "") return null;
  if (typeof b.size !== "number" || !Number.isFinite(b.size) || b.size < 0) return null;
  return { cid, mimeType: b.mimeType, size: b.size };
}

/** @param {string} reason */
const deny = reason => ({ ok: /** @type {false} */ (false), reason });

/**
 * Decide whether the requested bytes may be served. `record` is the
 * com.atproto.repo.getRecord response, or null when there is none.
 * @param {any} record
 * @param {string} rkey
 * @param {boolean} wantVideo
 * @returns {{ok: true, kind: "poster"|"video", cid: string, mimeType: string, size: number}
 *          | {ok: false, reason: string}}
 */
export function decideBlob(record, rkey, wantVideo) {
  const value = record && record.value;
  if (!value || typeof value !== "object") return deny("no-record");

  const poster = blobOf(value.poster);
  // The rkey IS the poster CID (lexicon). A record whose key disagrees with
  // its own poster blob is not servable at all — including on the video
  // path, since the key is the only thing binding this URL to this record.
  if (!poster || poster.cid !== rkey) return deny("poster-mismatch");

  const kind = wantVideo ? "video" : "poster";
  const blob = wantVideo ? blobOf(value.video) : poster;
  if (!blob) return deny(wantVideo ? "no-video" : "no-poster");

  const { prefix, maxSize } = LIMITS[kind];
  if (!blob.mimeType.toLowerCase().startsWith(prefix)) return deny("mime");
  if (blob.size > maxSize) return deny("size");

  return { ok: /** @type {true} */ (true), kind, cid: blob.cid, mimeType: blob.mimeType, size: blob.size };
}

/**
 * Where the DID document lives. Resolved per request so these URLs survive a
 * PDS migration. did:web follows the spec: no path segments means
 * `/.well-known/did.json`, path segments mean `<path>/did.json` (render's
 * copy always uses `.well-known`, which agrees for the bare-host form
 * everything in the corpus uses today).
 * @param {string} did
 * @returns {string | null}
 */
export function didDocUrl(did) {
  if (!DID_RE.test(did)) return null;
  if (did.startsWith("did:plc:")) return `https://plc.directory/${did}`;

  const segs = did.slice("did:web:".length).split(":");
  if (segs.some(s => !/^[A-Za-z0-9._%-]+$/.test(s))) return null;
  const host = decodeURIComponent(segs[0]); // %3A carries an explicit port
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  return segs.length === 1
    ? `https://${host}/.well-known/did.json`
    : `https://${host}/${segs.slice(1).map(decodeURIComponent).join("/")}/did.json`;
}

/**
 * The PDS endpoint from a DID document. Same selector as render/src/worker.ts.
 * @param {any} doc
 * @returns {string | null}
 */
export function pdsOf(doc) {
  const svc = (doc && Array.isArray(doc.service) ? doc.service : []).find(
    (/** @type {any} */ s) => s && (s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer")
  );
  const endpoint = svc && svc.serviceEndpoint;
  return typeof endpoint === "string" && /^https:\/\//.test(endpoint) ? endpoint : null;
}

/**
 * getRecord URL for a media record.
 * @param {string} pds @param {string} did @param {string} rkey
 */
export function getRecordUrl(pds, did, rkey) {
  return `${pds.replace(/\/$/, "")}/xrpc/com.atproto.repo.getRecord` +
    `?repo=${encodeURIComponent(did)}&collection=${MEDIA_COLLECTION}&rkey=${encodeURIComponent(rkey)}`;
}

/**
 * getBlob URL.
 * @param {string} pds @param {string} did @param {string} cid
 */
export function getBlobUrl(pds, did, cid) {
  return `${pds.replace(/\/$/, "")}/xrpc/com.atproto.sync.getBlob` +
    `?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
}
