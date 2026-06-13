// Task 5 — validate object-shaped attrs (attr.filter, attr.properties).
//
// Verifies that:
//   (a) an object-valued @filter on layout.dataGrid is ACCEPTED (no ERR_BAD_ATTR_VALUE).
//   (b) a string-valued @filter is REJECTED with ERR_BAD_ATTR_VALUE.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ParseError } from "../src/errors.js";

/** Build a minimal metadata doc with a layout.dataGrid whose @filter is `filter`. */
function docWith(filter: unknown) {
  return {
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Subscriber",
            children: [
              { "field.long": { name: "id" } },
              { "field.boolean": { name: "subscribed", "@filterable": true } },
              { "identity.primary": { "name": "id", "@fields": ["id"] } },
              {
                "layout.dataGrid": {
                  name: "active",
                  "@filter": filter,
                  "@columns": [],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

async function errorsFor(filter: unknown): Promise<ParseError[]> {
  const loader = new MetaDataLoader();
  const { errors } = await loader.load([
    new InMemoryStringSource(JSON.stringify(docWith(filter)), { id: "test.json" }),
  ]);
  return errors.filter((e): e is ParseError => e instanceof ParseError);
}

describe("attr-schema validation — object-valued attrs", () => {
  it("accepts an object-valued @filter (no ERR_BAD_ATTR_VALUE for @filter)", async () => {
    const errors = await errorsFor({ subscribed: true });
    const filterTypeErrors = errors.filter(
      (e) =>
        e.code === "ERR_BAD_ATTR_VALUE" &&
        (e.message.includes("@filter") || e.message.includes("filter")),
    );
    expect(filterTypeErrors).toHaveLength(0);
  });

  it("rejects a string-valued @filter with ERR_BAD_ATTR_VALUE", async () => {
    const errors = await errorsFor('{"subscribed":true}');
    const filterTypeErrors = errors.filter(
      (e) =>
        e.code === "ERR_BAD_ATTR_VALUE" &&
        (e.message.includes("@filter") || e.message.includes("filter")),
    );
    expect(filterTypeErrors.length).toBeGreaterThanOrEqual(1);
  });
});
