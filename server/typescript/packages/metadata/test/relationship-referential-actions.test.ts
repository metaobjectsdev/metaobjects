import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
}
const codesOf = (errors: readonly Error[]) => errors.map((e) => (e as { code?: string }).code);

describe("relationship @onDelete / @onUpdate", () => {
  test("valid kebab-case actions round-trip", async () => {
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Week", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId" } },
        { "relationship.composition": { name: "program", "@objectRef": "Program",
            "@cardinality": "one", "@onDelete": "cascade", "@onUpdate": "cascade" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
      ] } },
    ] } });
    expect(errors).toHaveLength(0);
    const out = canonicalSerialize(root);
    expect(out).toContain('"@onDelete": "cascade"');
    expect(out).toContain('"@onUpdate": "cascade"');
  });

  test("set-null and restrict are valid", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "X", children: [
        { "field.long": { name: "id" } },
        { "relationship.aggregation": { name: "y", "@objectRef": "Y", "@onDelete": "set-null" } },
        { "relationship.association": { name: "z", "@objectRef": "Z", "@onDelete": "restrict", "@onUpdate": "no-action" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Y", children: [{ "field.long": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } }] } },
      { "object.entity": { name: "Z", children: [{ "field.long": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } }] } },
    ] } });
    expect(codesOf(errors)).not.toContain("ERR_BAD_ATTR_VALUE");
  });

  test("invalid action value (setDefault) → ERR_BAD_ATTR_VALUE", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Week", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "p", "@objectRef": "X", "@onDelete": "setDefault" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "X", children: [{ "field.long": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } }] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });
});
