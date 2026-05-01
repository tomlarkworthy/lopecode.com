import { defineLexiconConfig } from "@atcute/lex-cli";

export default defineLexiconConfig({
  files: ["lexicons/custom/**/*.json", "lexicons/pulled/**/*.json", "lexicons/generated/**/*.json"],
  outdir: "src/lexicon-types/",
  imports: ["@atcute/atproto"],
  pull: {
    outdir: "lexicons/pulled/",
    sources: [
      {
        type: "atproto",
        mode: "nsids",
        nsids: [
                  "app.bsky.actor.profile",
                  "com.lopecode.bundle"
        ],
      },
    ],
  },
});
