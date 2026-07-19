import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";

async function load(json: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([new InMemoryStringSource(JSON.stringify(json), { id: "t.json" })]);
}

describe("view.image + @rows vocabulary", () => {
  test("a view.image field with all five attrs and a view.textarea @rows load under strict provenance", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          { "object.entity": { name: "Doc", children: [
            { "source.rdb": { "@table": "docs" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
            { "field.string": { name: "notes", children: [{ "view.textarea": { "@rows": 8 } }] } },
            { "field.string": { name: "coverKey", "@maxLength": 80, children: [
              { "view.image": { "@aspectRatio": 1.777, "@maxEdge": 2000, "@store": "photos",
                "@accept": ["image/jpeg", "image/png"], "@maxBytes": 10485760 } }
            ]}},
          ]}},
        ],
      },
    });
    expect(errors).toEqual([]);
  });
});
