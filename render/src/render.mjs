// Render a com.lopecode.bundle to a self-contained HTML file.
//
// Architectural seam: a bundle IS the output of exporter-3's serializer.
// `record.value.files` is every `<script[data-mime][id]>` block from the
// rendered HTML, captured flat and in DOM order. So we don't drive
// exporter-3's `book` cell (which would re-partition modules vs
// attachments and re-fetch the bootloader from observablehq.com); we
// drive `lopebook` — the chrome wrapper — and pass the bundle's files
// straight through as `blocks`.
//
// The only exporter-3 cell we actually need is `lopebook`; everything
// else (chrome, networking_script, main script) is wired through it.

import define from "./exporter-3.js";

// ---- collect cells from exporter-3 ----

const cells = new Map();

const fakeMain = {
  variable() {
    const v = {
      define(name, depsOrFn, fn) {
        if (typeof depsOrFn === "function") {
          fn = depsOrFn;
          depsOrFn = [];
        }
        cells.set(name, { deps: depsOrFn, fn });
        return v;
      }
    };
    return v;
  },
  define(name, depsOrFn, fn) {
    if (typeof depsOrFn === "function") {
      fn = depsOrFn;
      depsOrFn = [];
    }
    cells.set(name, { deps: depsOrFn, fn });
  }
};

const fakeRuntime = { module: () => fakeMain };
define(fakeRuntime, () => null);

// ---- lazy resolver with seedable cell values ----

export function makeResolver(seed = {}) {
  const values = new Map(Object.entries(seed));
  const inflight = new Map();

  async function valueOf(name) {
    if (values.has(name)) return values.get(name);
    if (inflight.has(name)) return inflight.get(name);

    const cell = cells.get(name);
    if (!cell) {
      throw new Error(
        `cell '${name}' not registered and no seed provided. ` +
        `If this depends on an external Observable module, seed it.`
      );
    }

    const promise = (async () => {
      const args = await Promise.all(cell.deps.map(d => valueOf(d)));
      return cell.fn(...args);
    })();

    inflight.set(name, promise);
    const v = await promise;
    values.set(name, v);
    inflight.delete(name);
    return v;
  }

  return valueOf;
}

// ---- bundle decoding ----
//
// File bytes vs script-block content:
//   encoding="text"        — blob bytes are UTF-8 of source/CSS/JSON
//   encoding="base64+gzip" — blob bytes are UTF-8 of the base64 string
//                            (at-write stored the textContent verbatim,
//                            never decoded the base64)
//   encoding="base64"      — blob bytes are raw binary
// Only "base64" needs re-encoding for <script> embedding; everything
// else is recovered with TextDecoder.

const bytesToBase64 = bytes => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const decode = (file, bytes) =>
  file.encoding === "base64"
    ? bytesToBase64(bytes)
    : new TextDecoder().decode(bytes);

const escapeAttr = s =>
  String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const escapeScriptTags = s => s.replaceAll("</script", "<\\/script");

const DEFAULT_BOOTLOADER = "@tomlarkworthy/bootloader";

// Pre-baked: lopebook's `diskDataUrl` cell transitively depends on htl's
// `html` builtin, which we don't want to drag in. Seeding the data URL
// directly short-circuits that dep chain.
const DISK_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyBmaWxsPSJ3aGl0ZSIgd2lkdGg9IjUwcHgiIGhlaWdodD0iNTBweCIgdmlld0JveD0iMCAwIDY0IDY0IiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IGhlaWdodD0iNCIgd2lkdGg9IjQiIHg9IjIwIiB5PSI1MCIvPjxyZWN0IGhlaWdodD0iNCIgd2lkdGg9IjE2IiB4PSIyOCIgeT0iNTAiLz48cGF0aCBkPSJNMzIsMzhhOCw4LDAsMSwwLTgtOEE4LjAwOSw4LjAwOSwwLDAsMCwzMiwzOFptMC0xMmE0LDQsMCwxLDEtNCw0QTQsNCwwLDAsMSwzMiwyNloiLz48cGF0aCBkPSJNNiw2Mkg1OGEyLDIsMCwwLDAsMi0yVjE1YTIsMiwwLDAsMC0uNTg2LTEuNDE0bC0xMS0xMUEyLDIsMCwwLDAsNDcsMkg2QTIsMiwwLDAsMCw0LDRWNjBBMiwyLDAsMCwwLDYsNjJabTQyLTRIMTZWNDZINDhaTTE2LDZIMzF2NGg0VjZoNHY4SDE2Wk04LDZoNFYxNmEyLDIsMCwwLDAsMiwySDQxYTIsMiwwLDAsMCwyLTJWNmgzLjE3Mkw1NiwxNS44MjlWNThINTJWNDRhMiwyLDAsMCwwLTItMkgxNGEyLDIsMCwwLDAtMiwyVjU4SDhaIi8+PC9zdmc+";

export async function renderBundle({ record, blobs, coverUrl }) {
  const valueOf = makeResolver({ diskDataUrl: DISK_DATA_URL });
  const lopebook = await valueOf("lopebook");

  const blocks = record.value.files
    .map(f => {
      const text = decode(f, blobs.get(f.id));
      return `<script id="${escapeAttr(f.id)}"
  type="text/plain"
  data-mime="${escapeAttr(f.blob.mimeType)}"
  data-encoding="${f.encoding}"
>
${escapeScriptTags(text)}
</script>`;
    })
    .join("\n");

  const cssUrls = record.value.files
    .filter(f => f.blob.mimeType === "text/css")
    .map(f => f.id);

  return lopebook({
    blocks,
    cssUrls,
    bootloader: DEFAULT_BOOTLOADER,
    title: record.value.title || "Lopecode notebook",
    description: record.value.description,
    image: coverUrl
  });
}

