// app.bsky.feed.generator Worker: surfaces the companion-bsky posts
// of recent com.lopecode.bundle records as a custom Bluesky feed,
// so a "Lopecode" tab can be pinned inside any Bluesky client and
// shows new lopebundles as they're published.
//
// Reached via service binding from the apex Worker
// (feed.lopecode.com → FEED).
//
// Endpoints:
//   GET /xrpc/app.bsky.feed.getFeedSkeleton?feed=...&limit=...&cursor=...
//   GET /xrpc/app.bsky.feed.describeFeedGenerator
//   GET /.well-known/did.json    (did:web service identity)
//
// On-chain: an `app.bsky.feed.generator` record under the registering
// DID declares the feed and points its `did` field at FEED_DID. The
// AppView resolves FEED_DID via the did:web doc this Worker serves.

interface Env {
  CONTRAIL: Fetcher;
}

const FEED_DID = "did:web:feed.lopecode.com";
const SERVICE_ENDPOINT = "https://feed.lopecode.com";

// The single feed we host. The rkey "lopecode" is what we'll use when
// writing the on-chain app.bsky.feed.generator record under the
// publisher DID (the @trendingnotebooks.bsky.social account, kept
// separate from the human author DID so Bluesky bio/branding can stay
// project-themed); describeFeedGenerator must list this exact URI.
const FEED_PUBLISHER_DID = "did:plc:a5yddar7vebmgjithmy4skj6"; // trendingnotebooks.bsky.social
const FEED_RKEY = "lopecode";
const FEED_URI = `at://${FEED_PUBLISHER_DID}/app.bsky.feed.generator/${FEED_RKEY}`;

interface BundleRecord {
  uri: string;
  cid: string;
  value: { createdAt: string; title?: string };
}

interface ContrailListRecordsResponse {
  records: BundleRecord[];
  cursor?: string;
}

// Sidecar rkey convention from at-write: companion app.bsky.feed.post
// shares the bundle's rkey, so a fetcher can derive one URI from the
// other without an index.
function bundleUriToCompanionPostUri(bundleUri: string): string | null {
  const m = bundleUri.match(/^at:\/\/([^/]+)\/com\.lopecode\.bundle\/(.+)$/);
  if (!m) return null;
  const [, did, rkey] = m;
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

function jsonResponse(body: unknown, status = 200, cacheSeconds = 60): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${cacheSeconds}`
    }
  });
}

function xrpcError(error: string, message: string, status = 400): Response {
  return jsonResponse({ error, message }, status, 0);
}

async function getFeedSkeleton(env: Env, url: URL): Promise<Response> {
  const feed = url.searchParams.get("feed");
  if (feed !== FEED_URI) {
    return xrpcError("UnknownFeed", `Unknown feed: ${feed}`, 400);
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30), 1), 100);
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const contrailUrl = new URL(
    "https://contrail.lopecode.com/xrpc/com.lopecode.bundle.listRecords"
  );
  contrailUrl.searchParams.set("sort", "-createdAt");
  contrailUrl.searchParams.set("limit", String(limit));
  if (cursor) contrailUrl.searchParams.set("cursor", cursor);

  const r = await env.CONTRAIL.fetch(contrailUrl.toString());
  if (!r.ok) {
    return xrpcError("UpstreamError", `Contrail ${r.status}`, 502);
  }
  const data = (await r.json()) as ContrailListRecordsResponse;

  const items = data.records
    .map(rec => bundleUriToCompanionPostUri(rec.uri))
    .filter((uri): uri is string => uri !== null)
    .map(post => ({ post }));

  return jsonResponse({ feed: items, cursor: data.cursor });
}

function describeFeedGenerator(): Response {
  return jsonResponse({
    did: FEED_DID,
    feeds: [{ uri: FEED_URI }]
  }, 200, 600);
}

function didDocument(): Response {
  return jsonResponse({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: FEED_DID,
    service: [
      {
        id: "#bsky_fg",
        type: "BskyFeedGenerator",
        serviceEndpoint: SERVICE_ENDPOINT
      }
    ]
  }, 200, 3600);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/did.json") return didDocument();
    if (url.pathname === "/xrpc/app.bsky.feed.getFeedSkeleton") {
      return getFeedSkeleton(env, url);
    }
    if (url.pathname === "/xrpc/app.bsky.feed.describeFeedGenerator") {
      return describeFeedGenerator();
    }

    return new Response("not found", { status: 404 });
  }
};
