// node --test src/page.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { BYLINE_HEADER, bylineHtml, bylineSuppressed, escapeAttr, injectBefore } from "./page.mjs";

const POST = "at://did:plc:j7nm3lrd5h7fm3sfhcv3lhfv/app.bsky.feed.post/3mnehmlq3sd2d";

test("byline links to the author's Ledger", () => {
  const h = bylineHtml("larkworthy.bsky.social");
  assert.match(h, /href="https:\/\/lopecode\.com\/@larkworthy\.bsky\.social"/);
  assert.match(h, />by @larkworthy\.bsky\.social</);
  assert.match(h, /id="lope-byline"/);
  assert.match(h, /onclick="this\.parentNode\.remove\(\)"/);
});

test("byline adds the bsky post link when the bundle carries one", () => {
  const h = bylineHtml("larkworthy.bsky.social", POST);
  assert.match(h, /href="https:\/\/bsky\.app\/profile\/larkworthy\.bsky\.social\/post\/3mnehmlq3sd2d"/);
  assert.match(h, /&middot; bsky/);
});

test("byline omits the bsky link without bskyPostUri, and for a non-post URI", () => {
  assert.doesNotMatch(bylineHtml("a.b"), /bsky\.app/);
  assert.doesNotMatch(bylineHtml("a.b", "at://did:plc:x/com.lopecode.bundle/y"), /bsky\.app/);
});

test("a DID stands in for a missing handle", () => {
  const h = bylineHtml("did:plc:j7nm3lrd5h7fm3sfhcv3lhfv");
  assert.match(h, /href="https:\/\/lopecode\.com\/@did%3Aplc%3Aj7nm3lrd5h7fm3sfhcv3lhfv"/);
});

test("escapeAttr closes attribute and tag escapes", () => {
  assert.equal(escapeAttr('a"<&b'), "a&quot;&lt;&amp;b");
});

test("injectBefore inserts before the closing tag, appends when absent", () => {
  assert.equal(injectBefore("<body>x</body>", "body", "<i>"), "<body>x<i></body>");
  assert.equal(injectBefore("<BODY>x</BODY>", "body", "<i>"), "<BODY>x<i></BODY>");
  assert.equal(injectBefore("x", "body", "<i>"), "x<i>");
});

// A lopebook carries exporter-3's source, whose HTML template is a
// literal `…</body></html>` inside a <script type="text/plain"> block.
test("injectBefore takes the LAST </body> and the FIRST </head>", () => {
  const doc = "<head>H</head><body>a<script>`</head></body>`</script>b</body>";
  assert.equal(
    injectBefore(doc, "body", "<i>"),
    "<head>H</head><body>a<script>`</head></body>`</script>b<i></body>"
  );
  assert.equal(
    injectBefore(doc, "head", "<i>"),
    "<head>H<i></head><body>a<script>`</head></body>`</script>b</body>"
  );
});

test("injectBefore keeps $-sequences in the markup literal", () => {
  assert.equal(injectBefore("<body></body>", "body", "$&$'"), "<body>$&$'</body>");
});

test("bylineSuppressed only fires on the apex proxy's header", () => {
  assert.equal(bylineSuppressed(new Headers()), false);
  assert.equal(bylineSuppressed(new Headers({ [BYLINE_HEADER]: "off" })), true);
  assert.equal(bylineSuppressed(new Headers({ [BYLINE_HEADER]: " OFF " })), true);
  assert.equal(bylineSuppressed(new Headers({ [BYLINE_HEADER]: "on" })), false);
  assert.equal(bylineSuppressed(undefined), false);
});
