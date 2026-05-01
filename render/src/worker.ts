// Render Worker: serves did-*.lopecode.com/r/:rkey by fetching the
// bundle from the author's PDS and assembling a self-contained HTML
// using exporter-3's `lopebook` cell. Same template as the publish
// path, no client-side hydration loop, no GitHub Pages dep.

import { parseHTML } from "linkedom";
import { Runtime } from "@observablehq/runtime";
import { Library } from "@observablehq/stdlib";
// @ts-expect-error — exporter-3.js is hand-rolled Observable JS, no types.
import define from "./exporter-3.js";

// linkedom needs to be installed as a global before the runtime boots,
// because Observable's `html` builtin reaches for `document`. We boot
// the runtime once per isolate and reuse it across requests.
const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
(globalThis as Record<string, unknown>).document = dom.document;
(globalThis as Record<string, unknown>).window = dom;
(globalThis as Record<string, unknown>).HTMLElement = dom.HTMLElement;
(globalThis as Record<string, unknown>).Node = dom.Node;
(globalThis as Record<string, unknown>).DocumentFragment = dom.DocumentFragment;

const runtime = new Runtime(new Library());
const main = runtime.module(define, () => null);
const lopebookPromise = main.value("lopebook") as Promise<
  (opts: { title?: string; blocks?: string; head?: string; cssUrls?: string[]; bootloader?: string }) => string
>;

const SUBDOMAIN_RE = /^did-([a-z]+)-([a-z0-9]+)\.lopecode\.com$/i;
const RKEY_RE = /^\/r\/([A-Za-z0-9._~-]+)\/?$/;

interface FileEntry {
  id: string;
  encoding: "text" | "base64";
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
    const doc = (await r.json()) as { service?: Array<{ id: string; type: string; serviceEndpoint: string }> };
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
    const doc = (await r.json()) as { service?: Array<{ id: string; type: string; serviceEndpoint: string }> };
    const svc = (doc.service ?? []).find(
      s => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer"
    );
    if (!svc) throw new Error(`No PDS service for ${did}`);
    return svc.serviceEndpoint;
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

async function fetchBundle(pds: string, did: string, rkey: string): Promise<BundleRecord> {
  const r = await fetch(
    `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=com.lopecode.bundle&rkey=${encodeURIComponent(rkey)}`
  );
  if (!r.ok) throw new Error(`getRecord ${r.status}`);
  return (await r.json()) as BundleRecord;
}

async function fetchBlob(pds: string, did: string, cid: string): Promise<Uint8Array> {
  const r = await fetch(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`);
  if (!r.ok) throw new Error(`getBlob ${cid}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const escapeScriptTags = (s: string): string => s.replaceAll("</scr\\ipt", "</scr\\\\ipt");
const escapeAttr = (s: string): string => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

function fileBlock(file: FileEntry, bytes: Uint8Array): string {
  const text =
    file.encoding === "text"
      ? new TextDecoder().decode(bytes)
      : bytesToBase64(bytes);
  return `<script id="${escapeAttr(file.id)}" type="text/plain" data-mime="${escapeAttr(file.blob.mimeType)}" data-encoding="${file.encoding}">
${escapeScriptTags(text)}
</script>`;
}

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
      const record = await fetchBundle(pds, did, rkey);
      const files = record.value.files;

      // Fetch blobs in parallel and assemble script blocks in original
      // order, so id-based lookups during boot resolve deterministically.
      const blobBytes = await Promise.all(files.map(f => fetchBlob(pds, did, f.blob.ref.$link)));
      const blocks = files.map((f, i) => fileBlock(f, blobBytes[i])).join("\n\n");

      const lopebook = await lopebookPromise;
      const html = lopebook({
        title: record.value.title || `Lopebook · ${did}/${rkey}`,
        blocks
      });

      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": `public, max-age=300` // CID-pin later for "immutable"
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return html404(`Render failed: <code>${escapeAttr(msg)}</code>`);
    }
  }
};
