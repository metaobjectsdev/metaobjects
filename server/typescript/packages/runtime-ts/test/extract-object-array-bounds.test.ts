import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { Format, FieldExtraction, orThrow, ExtractError } from "@metaobjectsdev/render";
import { extractObject, extractSchemaFor } from "../src/extract-object.js";

// validator.array (@min/@max) on an array field reaches the extract engine: a reply with
// too many elements keeps the first @max, and one with too few fails the strict gate. The
// model states the bound once; nothing downstream re-checks it by hand.
const META = JSON.stringify({ "metadata.root": { package: "app", children: [
  { "object.value": { name: "Suggestion", children: [
    { "field.string": { name: "tags", "@required": true, isArray: true, children: [
      { "validator.array": { name: "threeTags", "@min": 3, "@max": 3 } },
    ] } },
  ] } },
] } });

async function suggestion(): Promise<MetaObject> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(errors).toEqual([]);
  return root.findObject("Suggestion")!;
}

describe("extract honours validator.array bounds", () => {
  test("the schema carries the bounds", async () => {
    const tags = extractSchemaFor(await suggestion()).fields.find((f) => f.name === "tags")!;
    expect(tags.minItems).toBe(3);
    expect(tags.maxItems).toBe(3);
  });

  test("too many elements: the first @max are kept", async () => {
    const mo = await suggestion();
    const result = extractObject(mo, '{"tags":["a","b","c","d","e"]}', Format.JSON);
    expect(result.report.states().get("tags")).toBe(FieldExtraction.EXTRACTED);
    const tags = mo.fields().find((f) => f.name === "tags")!;
    expect(tags.getValue(orThrow(result)!)).toEqual(["a", "b", "c"]);
  });

  test("too few elements: MALFORMED, and the strict gate fails naming the field", async () => {
    const result = extractObject(await suggestion(), '{"tags":["a","b"]}', Format.JSON);
    expect(result.report.states().get("tags")).toBe(FieldExtraction.MALFORMED);
    expect(result.report.malformedRequired()).toEqual(["tags"]);
    expect(() => orThrow(result)).toThrow(ExtractError);
  });
});
