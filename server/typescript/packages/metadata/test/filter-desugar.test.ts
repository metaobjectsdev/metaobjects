import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { LAYOUT_DATA_GRID_ATTR_FILTER, TYPE_OBJECT, TYPE_LAYOUT } from "../src/constants.js";

async function loadGridFilter(filter: unknown): Promise<unknown> {
  const doc = {
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
              { "field.string": { name: "deletedAt", "@filterable": true } },
              { "identity.primary": { "@fields": ["id"] } },
              {
                "layout.dataGrid": {
                  name: "active",
                  "@filter": filter,
                  "@columns": ["status"],
                },
              },
            ],
          },
        },
      ],
    },
  };
  const loader = new MetaDataLoader();
  const { root } = await loader.load([
    new InMemorySource(JSON.stringify(doc), { id: "test.json" }),
  ]);
  const obj = root.children().find((c) => c.type === TYPE_OBJECT)!;
  const layout = obj.children().find((c) => c.type === TYPE_LAYOUT)!;
  return layout.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
}

describe("filter desugaring", () => {
  it("scalar → eq", async () => {
    expect(await loadGridFilter({ subscribed: true })).toEqual({ subscribed: { eq: true } });
  });
  it("array → in", async () => {
    expect(await loadGridFilter({ status: ["active", "pending"] })).toEqual({
      status: { in: ["active", "pending"] },
    });
  });
  it("null → isNull", async () => {
    expect(await loadGridFilter({ deletedAt: null })).toEqual({ deletedAt: { isNull: true } });
  });
  it("explicit op object is left unchanged", async () => {
    expect(await loadGridFilter({ status: { like: "a%" } })).toEqual({ status: { like: "a%" } });
  });
});
