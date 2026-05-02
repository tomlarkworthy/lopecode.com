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

const SIBLING_HOSTS = {
  "contrail.lopecode.com": "CONTRAIL"
};

// did-{method}-{rest}.lopecode.com — method is alpha (plc / web / key),
// rest is alphanumeric. did:plc ids are base32 lower a-z 2-7.
const SUBDOMAIN_RE = /^did-[a-z]+-[a-z0-9]+\.lopecode\.com$/i;

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

    if (SUBDOMAIN_RE.test(host)) {
      return env.RENDER.fetch(request);
    }

    return html404(`Unknown host: <code>${host}</code>`);
  }
};
