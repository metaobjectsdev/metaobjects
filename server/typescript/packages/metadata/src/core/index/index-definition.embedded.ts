// Embedded definition for the index type (core vocab — physical attrs come from db provider).
import type { ProviderDefinition } from "../../provider-data.js";

export const INDEX_DEFINITION: ProviderDefinition = {
  "provider": "metaobjects-core-types",
  "types": [
    {
      "type": "index",
      "subType": "lookup",
      "description": "A non-unique lookup index on one or more fields. Use for query-performance indexes that do NOT enforce uniqueness — declare identity.secondary for unique constraints instead.",
      "whenToUse": "You need a DB index for query performance (fast lookups/sorts) but NOT uniqueness enforcement. @fields names the indexed columns; the db provider adds @orders / @expr / @where / @using for physical tuning.",
      "children": [
        {
          "type": "attr",
          "subType": "string",
          "name": "fields",
          "isArray": true,
          "min": 1,
          "max": 1,
          "description": "The field name(s) this index covers (at least one). When @expr is present, it is the key expression derived from these fields."
        }
      ]
    }
  ]
};
