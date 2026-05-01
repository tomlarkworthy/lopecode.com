# lopecode.com

The web origin for [lopecode](https://github.com/tomlarkworthy/lopecode-dev) — preview gateway, profile pages, OAuth surface, indexer, and feed generator. Hosted on Cloudflare.

See [`specs/atproto.md`](https://github.com/tomlarkworthy/lopecode-dev/blob/main/specs/atproto.md) in lopecode-dev for the v1 plan that this domain implements.

## Repository layout

```
pages/public/             # Cloudflare Pages — apex lopecode.com
workers/proxy/            # (planned) wildcard *.lopecode.com web proxy Worker
workers/feed/             # (planned) feed.lopecode.com feed-generator Worker
contrail/                 # (planned) Contrail indexer Worker + D1
lexicons/                 # (planned) com.lopecode.* lexicon JSONs
```

Only `pages/public/` is wired up so far. Everything else is added in subsequent commits as the v1 plan progresses.

## Local preview

```sh
bun run preview
```

Serves `pages/public/` on `http://localhost:8788` via Python&rsquo;s built-in static server &mdash; zero install, fine for plain HTML.

For true Cloudflare Pages parity (`_redirects`, `_headers`, `_routes.json`, future Pages Functions):

```sh
bun run preview:cf
```

Runs `wrangler pages dev pages/public` on the same port. `bunx` fetches wrangler on demand.

## Deployment runbook

### One-time setup

#### 1. Move DNS for `lopecode.com` from Namecheap to Cloudflare

Registration stays at Namecheap; only DNS authority moves. This is required for Cloudflare's wildcard Universal SSL (covers `lopecode.com` + `*.lopecode.com` for free) and for binding Workers to subdomains later.

1. Cloudflare dashboard → **Add a site** → enter `lopecode.com` → pick **Free** plan for the zone (zones are free even on a paid Cloudflare account).
2. Cloudflare scans existing DNS and gives you 2 nameservers (e.g. `xxx.ns.cloudflare.com`).
3. Namecheap dashboard → **Domain List** → `lopecode.com` → **Manage** → **Nameservers** → set to **Custom DNS** → paste both Cloudflare nameservers → save.
4. Wait for propagation. Cloudflare emails you when the zone goes active (usually 5–30 minutes).
5. Once active, Universal SSL provisions automatically. Confirm under **SSL/TLS → Edge Certificates** that the cert covers `lopecode.com` and `*.lopecode.com`.

#### 2. Create the Cloudflare Pages project

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Authorize Cloudflare on GitHub if not already; select the **`tomlarkworthy/lopecode.com`** repo.
3. Project name: `lopecode-com` (or whatever — only affects the `*.pages.dev` URL).
4. Production branch: `main`.
5. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **`pages/public`**
6. Save and Deploy. First deploy lands at `lopecode-com.pages.dev` within ~30s.
7. **Custom domains** tab → add `lopecode.com` and `www.lopecode.com`. Cloudflare creates the CNAME records itself (because DNS is on Cloudflare).

PR previews are on by default — every PR opens a unique `<sha>.lopecode-com.pages.dev` URL.

### Day-to-day

- Push to `main` → Cloudflare Pages deploys automatically. No CI tokens needed; Pages uses its own GitHub integration.
- Open a PR → preview deploy on a unique URL. Merge after eyeballing.
- Workers (later): each Worker has its own `wrangler.toml` and is deployed via `wrangler deploy` from GitHub Actions using **Cloudflare's OIDC** (no long-lived API tokens). One workflow per Worker so failures stay isolated.

### Security stance

- DNS managed by Cloudflare → wildcard Universal SSL is free, no manual cert renewals.
- Pages uses GitHub-integrated deploys → no API tokens stored anywhere.
- Workers (when added) will use OIDC-federated Cloudflare API tokens scoped per-resource. No long-lived secrets.
- Branch protection on `main`: required reviews + Pages preview check passing before merge.
- This repo is **public**. Only public-safe artifacts go in (lexicons, OAuth client metadata, static HTML). Secrets live in `wrangler secret put`.
