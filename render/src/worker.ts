// Render Worker: serves did-*.lopecode.com/r/:rkey by fetching a
// com.lopecode.bundle record + its blobs from the author's PDS, then
// running them through the same renderBundle() that the local CLI
// smoke test uses. The bundle is the byte-output of exporter-3's
// serializer; we just feed its files back into exporter-3's lopebook
// chrome wrapper.

import { renderBundle } from "./render.mjs";

const SUBDOMAIN_RE = /^did-([a-z]+)-([a-z0-9]+)\.lopecode\.com$/i;
const RKEY_RE = /^\/r\/([A-Za-z0-9._~-]+)\/?$/;

// Bump to force a cache-key change on the upstream getBlob subrequest.
// Workers fetch caches by URL; CF dashboard purges don't reliably hit
// third-party-host subrequest entries. When poisoned 4xx entries get
// stuck (cf. earlier `cacheTtl: 31536000, cacheEverything: true` bug),
// bumping this is the in-band way to bust them.
const BLOB_CACHE_BUST = "1";

interface FileEntry {
  id: string;
  encoding: "text" | "base64" | "base64+gzip";
  blob: { ref: { $link: string }; mimeType: string; size: number };
}

interface BundleRecord {
  uri: string;
  cid: string;
  value: { title?: string; files: FileEntry[]; createdAt: string };
}

async function resolvePds(did: string): Promise<string> {
  if (did.startsWith("did:plc:")) {
    const r = await fetch(`https://plc.directory/${did}`);
    if (!r.ok) throw new Error(`plc.directory ${r.status}`);
    const doc = (await r.json()) as {
      service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
    };
    const svc = (doc.service ?? []).find(
      s => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer"
    );
    if (!svc) throw new Error(`No PDS service for ${did}`);
    return svc.serviceEndpoint;
  }
  if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).replace(/:/g, "/");
    const r = await fetch(`https://${host}/.well-known/did.json`);
    if (!r.ok) throw new Error(`did:web ${r.status}`);
    const doc = (await r.json()) as {
      service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
    };
    const svc = (doc.service ?? []).find(
      s => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer"
    );
    if (!svc) throw new Error(`No PDS service for ${did}`);
    return svc.serviceEndpoint;
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

const escapeAttr = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

function html404(message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>404</title><body style="font:16px system-ui;padding:8vh 1.25rem;text-align:center"><h1 style="font-size:4rem;margin:0">404</h1><p>${message}</p>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const m = host.match(SUBDOMAIN_RE);
    if (!m) return html404(`Unknown host: <code>${host}</code>`);
    const did = `did:${m[1].toLowerCase()}:${m[2].toLowerCase()}`;

    const p = url.pathname.match(RKEY_RE);
    if (!p) return html404("Expected <code>/r/:rkey</code>.");
    const rkey = p[1];

    try {
      const pds = await resolvePds(did);
      const recordRes = await fetch(
        `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=com.lopecode.bundle&rkey=${encodeURIComponent(rkey)}`
      );
      if (!recordRes.ok) throw new Error(`getRecord ${recordRes.status}`);
      const record = (await recordRes.json()) as BundleRecord;

      // ?file=<id> — return the decoded source of a single file as an
      // attachment. Skips the full-bundle blob fetch.
      const fileParam = url.searchParams.get("file");
      if (fileParam !== null) {
        const f = record.value.files.find(x => x.id === fileParam);
        if (!f) return html404(`No file <code>${escapeAttr(fileParam)}</code> in bundle.`);
        // ETag = the file's blob CID (content-addressed → bytes-equal iff
        // CID-equal). The slug-rkey publish flow means /r/{rkey}?file=…
        // has a stable URL across republishes, so we revalidate by CID.
        const fileEtag = `"${f.blob.ref.$link}"`;
        if (request.headers.get("if-none-match") === fileEtag) {
          return new Response(null, {
            status: 304,
            headers: {
              "etag": fileEtag,
              "cache-control": "public, max-age=0, must-revalidate",
              "access-control-allow-origin": "*"
            }
          });
        }
        const blobRes = await fetch(
          `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(f.blob.ref.$link)}&_cb=${BLOB_CACHE_BUST}`,
          {
            cf: {
              cacheEverything: true,
              cacheTtlByStatus: { "200-299": 31536000, "400-499": 0, "500-599": 0 }
            }
          }
        );
        if (!blobRes.ok) throw new Error(`getBlob ${f.id}: ${blobRes.status}`);
        const bytes = new Uint8Array(await blobRes.arrayBuffer());
        let body: ArrayBuffer | Uint8Array;
        if (f.encoding === "base64+gzip") {
          // Blob bytes are utf-8 of a base64 string; the decoded base64
          // is gzipped source. Decode → ungzip → original source bytes.
          const b64 = new TextDecoder().decode(bytes);
          const gz = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
          body = await new Response(stream).arrayBuffer();
        } else {
          // text → utf-8 source bytes; base64 → raw binary bytes.
          body = bytes;
        }
        const safeName = fileParam.replace(/[^A-Za-z0-9._@-]+/g, "_");
        return new Response(body, {
          headers: {
            "content-type": f.blob.mimeType,
            "content-disposition": `attachment; filename="${safeName}"`,
            "etag": fileEtag,
            "cache-control": "public, max-age=0, must-revalidate",
            "access-control-allow-origin": "*"
          }
        });
      }

      // ETag = the bundle record's CID. Stable URL (slug rkey) + content-
      // addressed CID lets us serve 304 from a cheap getRecord call when
      // the bundle hasn't changed. Without this, max-age would either let
      // republishes go stale or force a full re-render every hit.
      const recordEtag = `"${record.cid}"`;
      if (request.headers.get("if-none-match") === recordEtag) {
        return new Response(null, {
          status: 304,
          headers: {
            "etag": recordEtag,
            "cache-control": "public, max-age=0, must-revalidate",
            "access-control-allow-origin": "*"
          }
        });
      }

      const blobs = new Map<string, Uint8Array>();
      await Promise.all(
        record.value.files.map(async f => {
          // atproto blobs are content-addressed by CID — bytes are
          // immutable forever, so the CF edge cache can hold them
          // indefinitely. System modules (es-module-shims, runtime,
          // inspector) share CIDs across every bundle, so this also
          // warms cross-bundle.
          const r = await fetch(
            `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(f.blob.ref.$link)}&_cb=${BLOB_CACHE_BUST}`,
            {
              cf: {
                cacheEverything: true,
                cacheTtlByStatus: { "200-299": 31536000, "400-499": 0, "500-599": 0 }
              }
            }
          );
          if (!r.ok) throw new Error(`getBlob ${f.id}: ${r.status}`);
          blobs.set(f.id, new Uint8Array(await r.arrayBuffer()));
        })
      );

      const rawHtml = await renderBundle({ record, blobs });

      // standard.site verification: inject a <link rel="site.standard.document">
      // pointing at the AT-URI of the bundle's `site.standard.document` record
      // (sibling of the bundle, same rkey). Indexers crawl this tag to confirm
      // the published HTML really belongs to the claimed AT-URI; lopecode owns
      // the rendering path so we inject unconditionally — if the user hasn't
      // written the document record yet, the indexer simply 404s on resolve
      // and nothing else breaks. Idempotent: if the bundle already includes
      // the link (e.g. baked at build time), we don't double-insert.
      const stdDocAtUri = `at://${did}/site.standard.document/${rkey}`;
      const stdLinkTag = `<link rel="site.standard.document" href="${escapeAttr(stdDocAtUri)}">`;
      const html = rawHtml.includes('rel="site.standard.document"')
        ? rawHtml
        : rawHtml.replace(/<\/head>/i, `${stdLinkTag}</head>`);

      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "etag": recordEtag,
        "cache-control": "public, max-age=0, must-revalidate",
        "access-control-allow-origin": "*"
      };
      if (url.searchParams.get("download") !== null) {
        headers["content-disposition"] = `attachment; filename="${rkey}.html"`;
      }
      return new Response(html, { headers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return html404(`Render failed: <code>${escapeAttr(msg)}</code>`);
    }
  }
};
