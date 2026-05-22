import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { MetaReferenceIdentity } from "../../src/meta/meta-identity.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

describe("identity.reference subtype", () => {
  test("loads with bare entity target (defaults to primary)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "field.long": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "field.long": { name: "id" } },
            { "field.long": { name: "programId" } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
          ],
        },
      },
    ]);

    const purchase = root.objects().find((o) => o.name === "Purchase")!;
    const refs = purchase.referenceIdentities();
    expect(refs).toHaveLength(1);
    const ref = refs[0]!;
    expect(ref).toBeInstanceOf(MetaReferenceIdentity);
    expect(ref.fields).toEqual(["programId"]);
    expect(ref.targetEntity).toBe("Program");
    expect(ref.targetFields).toEqual([]);
  });

  test("loads with dotted Entity.field target", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Subscriber",
          children: [
            { "field.long":    { name: "id" } },
            { "field.string":  { name: "email" } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.secondary": { "@fields": "email" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "field.long":   { name: "id" } },
            { "field.string": { name: "customerEmail" } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_subscriber", "@fields": "customerEmail", "@references": "Subscriber.email" } },
          ],
        },
      },
    ]);

    const purchase = root.objects().find((o) => o.name === "Purchase")!;
    const ref = purchase.referenceIdentities()[0]!;
    expect(ref.targetEntity).toBe("Subscriber");
    expect(ref.targetFields).toEqual(["email"]);
  });

  test("loads compound reference", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Other",
          children: [
            { "field.long": { name: "a" } },
            { "field.long": { name: "b" } },
            { "identity.primary": { "@fields": ["a", "b"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Thing",
          children: [
            { "field.long": { name: "id" } },
            { "field.long": { name: "fa" } },
            { "field.long": { name: "fb" } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_other", "@fields": ["fa", "fb"], "@references": "Other.a,b" } },
          ],
        },
      },
    ]);

    const thing = root.objects().find((o) => o.name === "Thing")!;
    const ref = thing.referenceIdentities()[0]!;
    expect(ref.fields).toEqual(["fa", "fb"]);
    expect(ref.targetEntity).toBe("Other");
    expect(ref.targetFields).toEqual(["a", "b"]);
  });

  test("missing @references attr errors at load", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "Bad",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary":   { "@fields": "id" } },
                { "identity.reference": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const result = await new MetaDataLoader().load([new InMemorySource(json)]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /references/i.test(e.message))).toBe(true);
  });
});
