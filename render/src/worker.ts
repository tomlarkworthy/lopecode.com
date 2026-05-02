// Render Worker: serves did-*.lopecode.com/r/:rkey by fetching a
// com.lopecode.bundle record + its blobs from the author's PDS, then
// running them through the same renderBundle() that the local CLI
// smoke test uses. The bundle is the byte-output of exporter-3's
// serializer; we just feed its files back into exporter-3's lopebook
// chrome wrapper.

import { renderBundle } from "./render.mjs";

const SUBDOMAIN_RE = /^did-([a-z]+)-([a-z0-9]+)\.lopecode\.com$/i;
const RKEY_RE = /^\/r\/([A-Za-z0-9._~-]+)\/?$/;

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

      const blobs = new Map<string, Uint8Array>();
      await Promise.all(
        record.value.files.map(async f => {
          // atproto blobs are content-addressed by CID — bytes are
          // immutable forever, so the CF edge cache can hold them
          // indefinitely. System modules (es-module-shims, runtime,
          // inspector) share CIDs across every bundle, so this also
          // warms cross-bundle.
          const r = await fetch(
            `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(f.blob.ref.$link)}`,
            { cf: { cacheTtl: 31536000, cacheEverything: true } }
          );
          if (!r.ok) throw new Error(`getBlob ${f.id}: ${r.status}`);
          blobs.set(f.id, new Uint8Array(await r.arrayBuffer()));
        })
      );

      const html = await renderBundle({ record, blobs });

      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300"
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return html404(`Render failed: <code>${escapeAttr(msg)}</code>`);
    }
  }
};
