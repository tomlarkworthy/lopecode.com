// Markup the render Worker injects into an exported bundle.

// The apex Worker proxies its own chrome — the Lopefeed at `/` and the
// Ledger at `/@handle` — through /r/:rkey. Those pages are the site's
// furniture, not someone's published bundle, so they keep the head
// link/meta tags but not the byline pill. The proxy says so with this
// header; a direct request never carries it.
export const BYLINE_HEADER = "x-lopecode-byline";

/**
 * @param {Headers} [headers]
 * @returns {boolean}
 */
export function bylineSuppressed(headers) {
  return (headers?.get(BYLINE_HEADER) ?? "").trim().toLowerCase() === "off";
}

/**
 * @param {string} s
 * @returns {string}
 */
export const escapeAttr = s =>
  String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * A rendered bundle is the author's page but carries no trace of the
 * author: the exported HTML has no <a href> at all. This pill is the
 * only link back to their Ledger (lopecode.com/@handle) and to the
 * companion Bluesky post. Inline styles and one inline handler, so it
 * needs no external asset and cannot collide with the bundle's CSS.
 *
 * @param {string} handle  bare handle, or the DID when the doc has none
 * @param {string} [bskyPostUri]  at://…/app.bsky.feed.post/<tid>
 * @returns {string}
 */
export function bylineHtml(handle, bskyPostUri) {
  const ledger = `https://lopecode.com/@${encodeURIComponent(handle)}`;
  const tid = bskyPostUri?.match(/\/app\.bsky\.feed\.post\/([A-Za-z0-9._~-]+)$/)?.[1];
  const bsky = tid
    ? `<a href="https://bsky.app/profile/${escapeAttr(encodeURIComponent(handle))}/post/${escapeAttr(tid)}"` +
      ` target="_blank" rel="noopener" style="color:inherit;opacity:.7;text-decoration:none">&middot; bsky</a>`
    : "";
  return (
    `<div id="lope-byline" style="position:fixed;right:10px;bottom:10px;z-index:2147483000;` +
    `display:flex;gap:6px;align-items:center;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;` +
    `background:rgba(18,18,20,.72);color:#fff;padding:3px 5px 3px 9px;border-radius:11px;pointer-events:auto">` +
    `<a href="${escapeAttr(ledger)}" style="color:inherit;text-decoration:none">by @${escapeAttr(handle)}</a>` +
    bsky +
    `<span role="button" tabindex="0" aria-label="Dismiss" title="Dismiss"` +
    ` onclick="this.parentNode.remove()"` +
    ` style="cursor:pointer;opacity:.55;padding:0 3px;user-select:none">&times;</span>` +
    `</div>`
  );
}

/**
 * The document's own <head>, for "did the export already bake this tag?"
 * checks. Searching the whole document instead would false-positive: a
 * lopebook carries @tomlarkworthy/exporter-3's source, and that source
 * contains the literal `<meta property="og:image" ...>` of its own head
 * template inside a `<script type="text/plain">` block.
 *
 * @param {string} html
 * @returns {string}
 */
export function headOf(html) {
  const at = html.search(/<\/head>/i);
  return at === -1 ? html : html.slice(0, at);
}

/**
 * Insert `markup` before the document's own closing tag, or append when
 * it has none.
 *
 * `</head>` and `</body>` both occur more than once in a lopebook: the
 * bundle carries @tomlarkworthy/exporter-3's source, and that module's
 * HTML template is a literal ending `</body>\n</html>`, sitting in a
 * `<script type="text/plain">` block. Anchoring naively on the first
 * `</body>` injects into that template instead of the page. The
 * document's head closes before any block; its body closes after all of
 * them — so take the first head match and the last body match, and
 * splice rather than replace so the tag survives verbatim.
 *
 * @param {string} html
 * @param {"head"|"body"} tag
 * @param {string} markup
 * @returns {string}
 */
export function injectBefore(html, tag, markup) {
  const hits = [...html.matchAll(new RegExp(`</${tag}>`, "gi"))];
  if (!hits.length) return html + markup;
  const at = (tag === "body" ? hits[hits.length - 1] : hits[0]).index;
  return html.slice(0, at) + markup + html.slice(at);
}
