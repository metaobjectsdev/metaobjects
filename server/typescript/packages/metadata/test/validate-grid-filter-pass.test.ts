// Task 6 — load-time validation of dataGrid @filter values.
//
// Verifies that validateDataGridFilterValues:
//   (a) accepts a filter over @filterable fields with allowed ops — no ERR_BAD_ATTR_FILTER.
//   (b) rejects a filter over a non-filterable field — ERR_BAD_ATTR_FILTER.
//   (c) rejects a disallowed op for the field's subtype — ERR_BAD_ATTR_FILTER.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { ParseError } from "../src/errors.js";

/** Build a minimal metadata doc with filterable + non-filterable fields, and
 *  a dataGrid layout whose @filter is `filter`. */
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
              { "field.string": { name: "status", "@filterable": true } },
              { "field.string": { name: "notFilterable" } },
              { "identity.primary": { "@fields": ["id"] } },
              { "layout.dataGrid": { name: "active", "@filter": filter, "@columns": [] } },
            ],
          },
        },
      ],
    },
  };
}

async function filterErrorCodes(filter: unknown): Promise<number> {
  const loader = new MetaDataLoader();
  const { errors } = await loader.load([
    new InMemorySource(JSON.stringify(docWith(filter)), { id: "test.json" }),
  ]);
  return errors.filter(
    (e): e is ParseError => e instanceof ParseError && e.code === "ERR_BAD_ATTR_FILTER",
  ).length;
}

describe("validateDataGridFilterValues — load-time filter validation", () => {
  it("accepts a filter over filterable fields with compatible ops (no ERR_BAD_ATTR_FILTER)", async () => {
    const count = await filterErrorCodes({ subscribed: true, status: ["a"] });
    expect(count).toBe(0);
  });

  it("rejects a filter over a non-filterable field (ERR_BAD_ATTR_FILTER)", async () => {
    const count = await filterErrorCodes({ notFilterable: "x" });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("rejects a disallowed op for the field subtype (ERR_BAD_ATTR_FILTER) — like on boolean", async () => {
    const count = await filterErrorCodes({ subscribed: { like: "x%" } });
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
