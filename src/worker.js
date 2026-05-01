// lopecode.com Worker: routes by Host.
//
// - lopecode.com / www.lopecode.com → static assets (ASSETS binding,
//   served from pages/public/).
// - did-{method}-{rest}.lopecode.com/r/:rkey → 302 to the canonical
//   at-read deployment on GitHub Pages with the at:// URI in the hash.
//   This is the v1 minimum web proxy: visitors arriving from Bluesky
//   embed cards / RSS / plain web links land on a per-DID origin, get
//   bookmarkable URLs, and the bundle still renders. Later upgrade:
//   fetch the bundle from the PDS and serve composed HTML inline at
//   this origin so storage works.
//
// DID encoding: did:plc:abc123 → did-plc-abc123.lopecode.com (replace
// the two colons with hyphens). did:web encoding is TBD because DNS
// labels can't contain dots — only did:plc is supported in v1.

const APEX_HOSTS = new Set(["lopecode.com", "www.lopecode.com"]);

// Sibling Workers we forward to. The wildcard route on this Worker
// shadows Custom Domain bindings on sibling Workers, so explicit
// host-based forwarding via service bindings is the reliable path.
const SIBLING_HOSTS = {
  "contrail.lopecode.com": "CONTRAIL"
};

// did-{method}-{rest}.lopecode.com — method is alpha (plc / web / key /
// …), rest is alphanumeric (PLC ids are base32, lowercase a–z 2–7).
const SUBDOMAIN_RE = /^did-([a-z]+)-([a-z0-9]+)\.lopecode\.com$/i;

// Conservative subset of the atproto rkey grammar (TID-shaped 13 chars
// is the common case; full spec allows 1–512 chars from A-Za-z0-9._:~-,
// but `:` collides with URL semantics so we omit it).
const RKEY_RE = /^\/r\/([A-Za-z0-9._~-]+)\/?$/;

// Where the actual bundle gets rendered. Hash carries the at:// URI;
// at-read prefills its input from the hash and auto-loads.
const AT_READ_BASE = "https://tomlarkworthy.github.io/lopecode/notebooks/atproto.html";

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
      return env.ASSETS.fetch(request);
    }

    const sibling = SIBLING_HOSTS[host];
    if (sibling) {
      return env[sibling].fetch(request);
    }

    const m = host.match(SUBDOMAIN_RE);
    if (!m) {
      return html404(`Unknown host: <code>${host}</code>`);
    }
    const did = `did:${m[1].toLowerCase()}:${m[2].toLowerCase()}`;

    const p = url.pathname.match(RKEY_RE);
    if (!p) {
      return html404(`Expected <code>/r/:rkey</code> on a per-DID subdomain.`);
    }
    const rkey = p[1];
    const aturi = `at://${did}/com.lopecode.bundle/${rkey}`;
    // `view=S100(@tomlarkworthy/at-read)` mounts at-read fullscreen and is
    // sufficient on its own — adding `open=` on top double-mounts. `at=`
    // is the prefill consumed by at-read._ar_reader. Parens in view= are
    // literal — don't URL-encode them.
    const hash = `#view=S100(@tomlarkworthy/at-read)&at=${encodeURIComponent(aturi)}`;
    return Response.redirect(`${AT_READ_BASE}${hash}`, 302);
  }
};
