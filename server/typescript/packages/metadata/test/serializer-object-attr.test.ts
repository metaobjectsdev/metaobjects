import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { serializeJson } from "../src/serializer-json.js";

const doc = {
  "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Subscriber", children: [
      { "field.long": { name: "id" } },
      { "field.boolean": { name: "subscribed", "@filterable": true } },
      { "identity.primary": { "name": "id", "@fields": ["id"] } },
      { "layout.dataGrid": { name: "active", "@filter": { subscribed: true }, "@columns": [] } },
    ] } },
  ] },
};

describe("serializer object attr round-trip", () => {
  it("serializes @filter as an inline object and re-parses identically", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([ new InMemoryStringSource(JSON.stringify(doc), { id: "a.json" }) ]);
    const json = serializeJson(root);
    expect(json).toContain('"@filter"');

    const loader2 = new MetaDataLoader();
    const { root: root2 } = await loader2.load([ new InMemoryStringSource(json, { id: "b.json" }) ]);
    expect(serializeJson(root2)).toBe(json);
  });
});
