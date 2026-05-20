#!/usr/bin/env bun
// Publish com.lopecode.* lexicon JSON files as com.atproto.lexicon.schema
// records on the authority DID's PDS, so atproto-browser and other validators
// can resolve them via _lexicon.lopecode.com.
//
// Usage:
//   ATPROTO_DID=did:plc:j7nm3lrd5h7fm3sfhcv3lhfv \
//   ATPROTO_IDENTIFIER=tomlarkworthy.bsky.social \   # handle OR did, used to log in
//   ATPROTO_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//   bun lopecode.com/scripts/publish-lexicons.ts            # dry run
//   bun lopecode.com/scripts/publish-lexicons.ts --write    # actually publish
//
// If ATPROTO_DID is unset, it's derived from ATPROTO_IDENTIFIER via DNS / .well-known
// (more robust than bsky.social's resolveHandle for custom-domain handles).
//
//   bun lopecode.com/scripts/publish-lexicons.ts --only com.lopecode.bundle --write

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LEX_ROOTS = ["lopecode.com/contrail/lexicons/pulled", "lopecode.com/contrail/lexicons/generated", "lopecode.com/contrail/lexicons/custom"];
// Explicit allowlist — add an NSID here when its lexicon stabilizes.
// Everything else under com.lopecode.* is WIP and won't be published.
const PUBLISH = new Set([
  "com.lopecode.bundle",
  "com.lopecode.bundle.version",
]);
const SCHEMA_COLLECTION = "com.atproto.lexicon.schema";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ONLY = (() => { const i = args.indexOf("--only"); return i >= 0 ? args[i + 1] : null; })();

function walk(dir: string): string[] {
  const out: string[] = [];
  try { statSync(dir); } catch { return out; }
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}

type Lexicon = { lexicon: number; id: string; defs: Record<string, unknown> };

const lexicons = new Map<string, { lex: Lexicon; path: string }>();
for (const root of LEX_ROOTS) {
  for (const path of walk(root)) {
    let lex: Lexicon;
    try { lex = JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.error(`skip ${path}: ${e}`); continue; }
    if (!PUBLISH.has(lex.id)) continue;
    if (ONLY && lex.id !== ONLY) continue;
    const prior = lexicons.get(lex.id);
    if (prior) { console.warn(`duplicate id ${lex.id}: keeping ${prior.path}, ignoring ${path}`); continue; }
    lexicons.set(lex.id, { lex, path });
  }
}

if (lexicons.size === 0) { console.error(`No lexicons found under ${LEX_ROOTS.join(", ")}${ONLY ? ` matching --only ${ONLY}` : ""}`); process.exit(1); }
console.error(`Found ${lexicons.size} lexicon(s) on the allowlist:`);
for (const { lex, path } of lexicons.values()) console.error(`  ${lex.id}  ← ${path}`);
console.error("");

const IDENTIFIER = process.env.ATPROTO_IDENTIFIER ?? process.env.ATPROTO_HANDLE;
const APP_PASSWORD = process.env.ATPROTO_APP_PASSWORD;
const ENV_DID = process.env.ATPROTO_DID;
if (!IDENTIFIER || !APP_PASSWORD) { console.error("Set ATPROTO_IDENTIFIER (handle or DID) and ATPROTO_APP_PASSWORD"); process.exit(1); }

async function xrpc(base: string, nsid: string, method: "GET" | "POST", body: unknown, jwt?: string): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const init: RequestInit = { method, headers };
  let url = `${base}/xrpc/${nsid}`;
  if (method === "GET" && body && typeof body === "object") {
    const qs = new URLSearchParams(body as Record<string, string>).toString();
    if (qs) url += `?${qs}`;
  } else if (method === "POST") {
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${nsid} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function resolvePds(did: string): Promise<string> {
  const doc = await fetch(did.startsWith("did:plc:") ? `https://plc.directory/${did}` : `https://${did.slice(8)}/.well-known/did.json`).then(r => r.json());
  const svc = (doc.service ?? []).find((s: any) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer");
  if (!svc?.serviceEndpoint) throw new Error(`No PDS in DID doc for ${did}`);
  return svc.serviceEndpoint;
}

// Resolve handle → DID via the official multi-method route. Tries .well-known on the
// handle's host first (works for custom-domain handles), then DNS TXT, then falls back
// to the public AppView. Skipped when ATPROTO_DID is set.
async function resolveHandle(handle: string): Promise<string> {
  try {
    const r = await fetch(`https://${handle}/.well-known/atproto-did`);
    if (r.ok) { const did = (await r.text()).trim(); if (did.startsWith("did:")) return did; }
  } catch {}
  try {
    const r = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
    if (r.ok) return (await r.json()).did;
  } catch {}
  throw new Error(`Could not resolve handle ${handle} via .well-known or public AppView`);
}

const did = ENV_DID ?? (IDENTIFIER.startsWith("did:") ? IDENTIFIER : await resolveHandle(IDENTIFIER));
const pds = await resolvePds(did);
const session = await xrpc(pds, "com.atproto.server.createSession", "POST", { identifier: IDENTIFIER, password: APP_PASSWORD });
if (session.did !== did) { console.error(`Warning: session DID ${session.did} != configured ${did}; using session DID`); }
const jwt = session.accessJwt;
const authorityDid = session.did;
console.error(`Authority: ${authorityDid} on ${pds}${WRITE ? "" : "  (dry run — pass --write to publish)"}`);

let publishCount = 0, unchangedCount = 0, failCount = 0;
for (const { lex, path } of lexicons.values()) {
  const record = { $type: SCHEMA_COLLECTION, ...lex };
  let existing: any = null;
  try {
    existing = await xrpc(pds, "com.atproto.repo.getRecord", "GET", { repo: authorityDid, collection: SCHEMA_COLLECTION, rkey: lex.id });
  } catch (e: any) {
    if (!String(e.message).includes("RecordNotFound") && !String(e.message).includes("404")) console.error(`getRecord ${lex.id}: ${e.message}`);
  }
  const unchanged = existing && JSON.stringify(existing.value) === JSON.stringify(record);
  if (unchanged) { console.error(`= ${lex.id}  (unchanged)`); unchangedCount++; continue; }

  const action = existing ? "update" : "create";
  console.error(`${WRITE ? "+" : "?"} ${lex.id}  (${action})  ← ${path}`);
  if (!WRITE) continue;

  try {
    const body: Record<string, unknown> = { repo: authorityDid, collection: SCHEMA_COLLECTION, rkey: lex.id, record };
    if (existing?.cid) body.swapRecord = existing.cid;
    await xrpc(pds, "com.atproto.repo.putRecord", "POST", body, jwt);
    publishCount++;
  } catch (e: any) {
    console.error(`  FAIL: ${e.message}`); failCount++;
  }
}

console.error(`\n${WRITE ? "Published" : "Would publish"}: ${WRITE ? publishCount : lexicons.size - unchangedCount}, unchanged: ${unchangedCount}${failCount ? `, failed: ${failCount}` : ""}`);
if (failCount) process.exit(1);
