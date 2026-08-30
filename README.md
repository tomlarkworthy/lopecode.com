# lopecode.com

The web origin for [lopecode](https://github.com/tomlarkworthy/lopecode-dev) — preview gateway, profile pages, OAuth surface, indexer, and feed generator. Hosted on Cloudflare.

See [`specs/atproto.md`](https://github.com/tomlarkworthy/lopecode-dev/blob/main/specs/atproto.md) in lopecode-dev for the v1 plan that this domain implements.

The apex (`lopecode.com`) is served by a **Workers Static Assets** project named `lopecode`, configured by `wrangler.jsonc` at the repo root. Future Worker code for the per-DID web proxy, the feed generator, and the Contrail indexer will land in this same Worker (or sibling Workers) — Workers Static Assets is Cloudflare's unified successor to Pages, so we stay on one platform end-to-end.

## Repository layout

```
wrangler.jsonc            # Worker config: routes, assets binding
src/worker.js             # Worker entry: Host-based routing
pages/public/             # Static assets: 404 page + the OAuth relay surface
render/                   # lopecode-render Worker: bundle -> HTML (did-*.lopecode.com)
feed/                     # lopecode-feed Worker: app.bsky.feed.generator
contrail/                 # lopecode-contrail Worker: com.lopecode.bundle indexer
```

The Worker routes by Host, and runs before the assets binding (`run_worker_first`). On the apex it serves `/` and `/@handle` by rendering a published bundle — the Lopefeed and the Ledger — through the render Worker, so both are notebooks, not static pages; `pages/public/` is reached only for what those routes do not claim, which today is the 404 page and the OAuth relay surface. `did-{method}-{rest}.lopecode.com` goes to the render Worker: `/r/:rkey` renders that bundle, `/.well-known/site.standard.publication` answers standard.site verification, and `/` serves the author's Ledger. Sibling Workers on their own subdomains (`contrail`, `feed`) are forwarded by service binding, because the wildcard route shadows their Custom Domains.

## Tests and typecheck

```sh
npm test        # node:test units in render/ and feed/
npm run typecheck   # tsc --noEmit over render, feed, contrail
```

`npm --prefix render run test:render` is a network smoke test: it pulls a
live bundle and writes `render/tmp/test-render.html`.

## Local preview

```sh
bun run preview
```

Serves `pages/public/` on `http://localhost:8788` via Python&rsquo;s built-in static server &mdash; zero install, fine for plain HTML. There is no `index.html`, so the root is a directory listing; the pages worth opening are `/404.html` and `/oauth/`.

For true Cloudflare parity (assets binding, `_redirects`, `_headers`, future Worker entry):

```sh
bun run preview:cf
```

Runs `wrangler dev` against the local `wrangler.jsonc` on the same port. `bunx` fetches wrangler on demand.

## Deployment runbook

### One-time setup

#### 1. Move DNS for `lopecode.com` from Namecheap to Cloudflare

Registration stays at Namecheap; only DNS authority moves. This is required for Cloudflare's wildcard Universal SSL (covers `lopecode.com` + `*.lopecode.com` for free) and for binding Workers to subdomains later.

1. Cloudflare dashboard → **Add a site** → enter `lopecode.com` → pick **Free** plan for the zone (zones are free even on a paid Cloudflare account).
2. Cloudflare scans existing DNS and gives you 2 nameservers (e.g. `xxx.ns.cloudflare.com`).
3. Namecheap dashboard → **Domain List** → `lopecode.com` → **Manage** → **Nameservers** → set to **Custom DNS** → paste both Cloudflare nameservers → save.
4. Wait for propagation. Cloudflare emails you when the zone goes active (usually 5–30 minutes).
5. Once active, Universal SSL provisions automatically. Confirm under **SSL/TLS → Edge Certificates** that the cert covers `lopecode.com` and `*.lopecode.com`.

#### 2. Create the Cloudflare Worker (Workers Static Assets, git-integrated)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Connect to Git** (modern UI defaults to Workers Builds, which is what we want).
2. Authorize Cloudflare on GitHub if not already; select the **`tomlarkworthy/lopecode.com`** repo.
3. Worker name: `lopecode` (matches the `name` field in `wrangler.jsonc`; only affects the `*.workers.dev` URL).
4. Production branch: `main`. Build command empty. Workers Builds reads `wrangler.jsonc` directly.
5. Save and Deploy. First successful build serves the static assets from `pages/public/`.
6. **Settings → Domains & Routes**:
   - Optionally enable the `lopecode.<account>.workers.dev` URL for ad-hoc testing.
   - **Add Custom Domain** → `lopecode.com` and `www.lopecode.com`. Cloudflare creates the routing records itself (DNS is already on Cloudflare).

#### 3. Wildcard DNS for the per-DID web proxy

The Worker claims `*.lopecode.com/*` via a Route declared in `wrangler.jsonc`. For the Route to intercept anything, DNS has to resolve. Add one record:

- DNS → **Add record** → Type **AAAA** → Name **`*`** → IPv6 address **`100::`** (the discard prefix; never reachable, but resolves) → Proxy status **Proxied** (orange cloud).

Cloudflare's edge sees the proxied wildcard, the Worker Route matches, and `did-…lopecode.com/r/:rkey` is served by `src/worker.js` before any actual origin is hit. Universal SSL already covers `*.lopecode.com` so HTTPS just works.

PR previews are on by default — every PR triggers a non-production Workers build with its own preview URL.

### Day-to-day

- Push to `main` → Workers Builds deploys automatically. No CI tokens needed; the GitHub integration handles auth.
- Open a PR → preview deploy with a unique URL. Merge after eyeballing.
- That connection covers the **apex Worker only**. `feed/`, `render/` and `contrail/` are separate
  Cloudflare Workers; a push touching them does not redeploy them by itself. On 2026-08-30 a push
  carrying a `feed` fix redeployed apex and render and left `lopecode-feed` on the previous code —
  `getFeedSkeleton` kept returning post URIs derived from the bundle rkey, with nothing to show that
  the deploy had not happened.
- `.github/workflows/deploy-workers.yml` closes that gap: on a push to `main` it deploys each sibling
  Worker whose own directory changed (running that Worker's tests and typecheck first), and
  `workflow_dispatch` deploys one or all on demand. Editing the workflow redeploys everything, so a
  change to the pipeline is exercised rather than merely committed.
- It needs two repository secrets: **`CLOUDFLARE_API_TOKEN`** (a scoped token with
  *Workers Scripts:Edit*, not the Global API key) and **`CLOUDFLARE_ACCOUNT_ID`** (no `wrangler.jsonc`
  here declares `account_id`, so the token alone is ambiguous on a multi-account login).
- If you connect a sibling to Workers Builds in the dashboard, remove it from that workflow's matrix.
  A double deploy ships the same artifact, but it stops being obvious which pipeline did.

### Security stance

- DNS managed by Cloudflare → wildcard Universal SSL is free, no manual cert renewals.
- Apex Worker uses GitHub-integrated deploys → no API tokens stored anywhere.
- Sibling Workers deploy from GitHub Actions with a scoped `CLOUDFLARE_API_TOKEN` repository secret.
  This was specified as OIDC-federated; Cloudflare's API has no GitHub OIDC trust relationship to
  federate against, so it is a stored token limited to *Workers Scripts:Edit*. Rotate it from the
  Cloudflare dashboard; nothing else in this repo reads it.
- Branch protection on `main`: required reviews + Workers preview check passing before merge.
- This repo is **public**. Only public-safe artifacts go in (lexicons, OAuth client metadata, static HTML). Secrets live in `wrangler secret put`.
