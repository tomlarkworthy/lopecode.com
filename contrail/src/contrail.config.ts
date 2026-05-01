import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "com.lopecode",
  collections: {
    bundle: {
      collection: "com.lopecode.bundle",
      queryable: { createdAt: { type: "range" } },
      searchable: ["title"],
    },
  },
};
