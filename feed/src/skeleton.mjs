// Bundle records -> app.bsky.feed.getFeedSkeleton items.
//
// The post URI is read off the record. An earlier version derived
// `app.bsky.feed.post/<bundle rkey>` from the bundle URI on the theory
// that at-write gave the companion post the bundle's rkey; it does not
// — app.bsky.feed.post is key:tid, so at-write mints a TID and records
// it as `bskyPostUri`. Every derived URI named a post that does not
// exist, and the AppView dropped the whole feed.

const POST_URI_RE = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._~-]+$/;

/**
 * @param {Array<{value?: {bskyPostUri?: string}}>} records
 * @returns {Array<{post: string}>}
 */
export function skeletonItems(records) {
  return (records ?? [])
    .map(r => r?.value?.bskyPostUri)
    .filter(uri => typeof uri === "string" && POST_URI_RE.test(uri))
    .map(post => ({ post }));
}
