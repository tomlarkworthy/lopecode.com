// lopecode.com Worker: routes by Host.
//
// - lopecode.com / www.lopecode.com → static assets (ASSETS binding,
//   served from pages/public/).
// - {host}.lopecode.com listed in SIBLING_HOSTS → forwarded via service
//   binding. Used because the wildcard Route on this Worker shadows
//   Custom Domain bindings on sibling Workers; explicit host-based
//   forwarding is the reliable path.
// - did-{method}-{rest}.lopecode.com/* → forwarded to the lopecode-
//   render Worker, which fetches the bundle from the author's PDS and
//   serves it as composed HTML at the per-DID origin.

const APEX_HOSTS = new Set(["lopecode.com", "www.lopecode.com"]);

// Profile pages: /@handle on the apex serves the @lopecode/ledger
// notebook bundle via the render Worker, so the address bar stays at
// the clean lopecode.com/@handle URL while the page is the full
// reactive Ledger experience. The ledger module reads
// location.pathname for the handle (in addition to ?handle= and
// hashParams.handle).
//
// LEDGER pins the published profile bundle (served at /@handle).
// LOPEFEED pins the homepage discovery feed (served at /).
// Bumping a rkey here promotes a new build to the apex route.
const LEDGER_DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
const LEDGER_RKEY = "ledger";
const LOPEFEED_DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
const LOPEFEED_RKEY = "lopefeed";
const PROFILE_PATH_RE = /^\/@[^\/?#]+\/?$/;

async function proxyBundle(request, env, originalUrl, did, rkey) {
  const renderUrl = new URL(originalUrl.toString());
  renderUrl.hostname = `did-${did.replace(/^did:/, "").replace(/:/g, "-")}.lopecode.com`;
  renderUrl.pathname = `/r/${rkey}`;
  // Pass through to the render Worker; the response body is the
  // composed lopebook HTML — we relay it as-is so the URL bar keeps
  // its original path.
  const renderRequest = new Request(renderUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer()
  });
  const upstream = await env.RENDER.fetch(renderRequest);
  // Clone headers so we can override cache-control without leaking the
  // render Worker's headers verbatim (it sets max-age=300 which is fine
  // but we may want to vary by URL eventually).
  const headers = new Headers(upstream.headers);
  return new Response(upstream.body, { status: upstream.status, headers });
}

const SIBLING_HOSTS = {
  "contrail.lopecode.com": "CONTRAIL",
  "feed.lopecode.com": "FEED"
};

// did-{method}-{rest}.lopecode.com — method is alpha (plc / web / key),
// rest is alphanumeric. did:plc ids are base32 lower a-z 2-7.
const SUBDOMAIN_RE = /^did-[a-z]+-[a-z0-9]+\.lopecode\.com$/i;

// Reverse the subdomain encoding used by proxyBundle: a did `did:plc:abc`
// is encoded as `did-plc-abc.lopecode.com`. For SUBDOMAIN_RE-matching
// hosts, the first hyphen-separated segment after the `did-` prefix is the
// method, the remainder is the method-specific identifier.
function subdomainToDid(host) {
  const m = host.toLowerCase().match(/^did-([a-z]+)-([a-z0-9]+)\.lopecode\.com$/i);
  if (!m) return null;
  return `did:${m[1]}:${m[2]}`;
}

// standard.site verification endpoint. Per spec, the body is a single
// AT-URI in text/plain pointing at the user's `site.standard.publication`
// record (singleton at rkey=self). Indexers fetch this from each
// publication's declared `url` to confirm the hosting really represents
// the claimed publication. We serve it for every DID-subdomain host
// before forwarding the rest of the path to the render Worker.
function handleStandardSiteWellKnown(host) {
  const did = subdomainToDid(host);
  if (!did) {
    return new Response("unknown host", { status: 404 });
  }
  return new Response(`at://${did}/site.standard.publication/self\n`, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*"
    }
  });
}

// OAuth relay: short-lived store keyed by the OAuth `state` nonce. Used
// to bridge the auth-server popup (top-level lopecode.com) back to the
// notebook (file:// or other origin) — Chrome's storage partitioning
// blocks BroadcastChannel between an iframe-of-lopecode.com inside a
// file:// page and the top-level popup, so we mediate on the server.
//
// State is a 128-bit unguessable nonce minted by the notebook; possession
// of state is the capability to read/write the slot. Auth codes routed
// through here are PKCE+DPoP-bound — even if leaked, they can't be
// redeemed without the verifier and DPoP private key, which never leave
// the notebook.
const OAUTH_RELAY_PREFIX = "/oauth/relay/";
const OAUTH_RELAY_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const OAUTH_RELAY_TTL = 300; // seconds
const OAUTH_RELAY_MAX_BODY = 8192;

function oauthRelayCors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "vary": "origin"
  };
}

async function handleOAuthRelay(request, url) {
  const state = decodeURIComponent(url.pathname.slice(OAUTH_RELAY_PREFIX.length));
  if (!OAUTH_RELAY_STATE_RE.test(state)) {
    return new Response("invalid state", { status: 400, headers: oauthRelayCors() });
  }
  const cache = caches.default;
  // Internal-only key; the public path is /oauth/relay/<state>, but the
  // cache is keyed by a synthetic URL so it can't be reached by external
  // GET (which would bypass the delete-on-read semantics below).
  const cacheKey = new Request(`https://lopecode-internal.invalid/__oauth_relay__/${state}`);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: oauthRelayCors() });
  }

  if (request.method === "POST") {
    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      return new Response("expected application/json", { status: 415, headers: oauthRelayCors() });
    }
    const body = await request.text();
    if (body.length > OAUTH_RELAY_MAX_BODY) {
      return new Response("payload too large", { status: 413, headers: oauthRelayCors() });
    }
    try { JSON.parse(body); } catch {
      return new Response("invalid json", { status: 400, headers: oauthRelayCors() });
    }
    await cache.put(cacheKey, new Response(body, {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${OAUTH_RELAY_TTL}`
      }
    }));
    return new Response(null, { status: 204, headers: oauthRelayCors() });
  }

  if (request.method === "GET") {
    const hit = await cache.match(cacheKey);
    if (!hit) {
      return new Response("", { status: 404, headers: oauthRelayCors() });
    }
    // Delete-on-read: the notebook is the only legitimate consumer; once
    // it has the params, no one else should be able to fetch them again.
    await cache.delete(cacheKey);
    const body = await hit.text();
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", ...oauthRelayCors() }
    });
  }

  return new Response("method not allowed", { status: 405, headers: oauthRelayCors() });
}

function html404(message) {
  const body = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 &middot; lopecode.com</title>
<style>
  :root { color-scheme: light dark }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; padding: 8vh 1.25rem; background: #fafafa; color: #111; text-align: center }
  @media (prefers-color-scheme: dark) { body { background: #0e0e10; color: #eaeaea } }
  main { max-width: 32rem; margin: 0 auto }
  h1 { font-size: 4rem; margin: 0 }
  code { font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(127,127,127,0.12); padding: 1px 5px; border-radius: 3px }
  a { color: #2962ff }
  @media (prefers-color-scheme: dark) { a { color: #82b1ff } }
</style>
</head><body><main>
<h1>404</h1>
<p>${message}</p>
<p><a href="https://lopecode.com/">lopecode.com</a></p>
</main></body></html>`;
  return new Response(body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    if (APEX_HOSTS.has(host)) {
      if (url.pathname.startsWith(OAUTH_RELAY_PREFIX)) {
        return handleOAuthRelay(request, url);
      }
      if (PROFILE_PATH_RE.test(url.pathname)) {
        return proxyBundle(request, env, url, LEDGER_DID, LEDGER_RKEY);
      }
      if (url.pathname === "/" || url.pathname === "") {
        return proxyBundle(request, env, url, LOPEFEED_DID, LOPEFEED_RKEY);
      }
      return env.ASSETS.fetch(request);
    }

    const sibling = SIBLING_HOSTS[host];
    if (sibling) {
      return env[sibling].fetch(request);
    }

    if (SUBDOMAIN_RE.test(host)) {
      if (url.pathname === "/.well-known/site.standard.publication") {
        return handleStandardSiteWellKnown(host);
      }
      return env.RENDER.fetch(request);
    }

    return html404(`Unknown host: <code>${host}</code>`);
  }
};
