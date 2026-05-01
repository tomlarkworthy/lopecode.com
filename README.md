# lopecode.com

The web origin for [lopecode](https://github.com/tomlarkworthy/lopecode-dev) — preview gateway, profile pages, OAuth surface, indexer, and feed generator. Hosted on Cloudflare.

See [`specs/atproto.md`](https://github.com/tomlarkworthy/lopecode-dev/blob/main/specs/atproto.md) in lopecode-dev for the v1 plan that this domain implements.

The apex (`lopecode.com`) is served by a **Workers Static Assets** project named `lopecode`, configured by `wrangler.jsonc` at the repo root. Future Worker code for the per-DID web proxy, the feed generator, and the Contrail indexer will land in this same Worker (or sibling Workers) — Workers Static Assets is Cloudflare's unified successor to Pages, so we stay on one platform end-to-end.

## Repository layout

```
wrangler.jsonc            # Worker config: name, compat date, assets binding
pages/public/             # Static assets served at lopecode.com (apex)
workers/proxy/            # (planned) wildcard *.lopecode.com web proxy Worker
workers/feed/             # (planned) feed.lopecode.com feed-generator Worker
contrail/                 # (planned) Contrail indexer Worker + D1
lexicons/                 # (planned) com.lopecode.* lexicon JSONs
```

Only the apex Worker (`wrangler.jsonc` + `pages/public/`) is wired up so far. Everything else is added in subsequent commits as the v1 plan progresses.

## Local preview

```sh
bun run preview
```

Serves `pages/public/` on `http://localhost:8788` via Python&rsquo;s built-in static server &mdash; zero install, fine for plain HTML.

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

PR previews are on by default — every PR triggers a non-production Workers build with its own preview URL.

### Day-to-day

- Push to `main` → Workers Builds deploys automatically. No CI tokens needed; the GitHub integration handles auth.
- Open a PR → preview deploy with a unique URL. Merge after eyeballing.
- Future Workers in `workers/` get their own `wrangler.jsonc` and are deployed via `wrangler deploy` from GitHub Actions using **Cloudflare's OIDC** (no long-lived API tokens). One workflow per Worker so failures stay isolated.

### Security stance

- DNS managed by Cloudflare → wildcard Universal SSL is free, no manual cert renewals.
- Apex Worker uses GitHub-integrated deploys → no API tokens stored anywhere.
- Sibling Workers (when added) use OIDC-federated Cloudflare API tokens scoped per-resource. No long-lived secrets.
- Branch protection on `main`: required reviews + Workers preview check passing before merge.
- This repo is **public**. Only public-safe artifacts go in (lexicons, OAuth client metadata, static HTML). Secrets live in `wrangler secret put`.
