import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

describe("MetaReferenceIdentity.enforce", () => {
  test("defaults to true when @enforce is omitted", async () => {
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
    expect(purchase.referenceIdentities()[0]!.enforce).toBe(true);
  });

  test("reads explicit @enforce: true", async () => {
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
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program", "@enforce": true } },
          ],
        },
      },
    ]);

    const purchase = root.objects().find((o) => o.name === "Purchase")!;
    expect(purchase.referenceIdentities()[0]!.enforce).toBe(true);
  });

  test("reads explicit @enforce: false (soft reference)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Subscriber",
          children: [
            { "field.long":   { name: "id" } },
            { "field.string": { name: "email" } },
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
            {
              "identity.reference": {
                name: "ref_subscriber",
                "@fields": "customerEmail",
                "@references": "Subscriber.email",
                "@enforce": false,
              },
            },
          ],
        },
      },
    ]);

    const purchase = root.objects().find((o) => o.name === "Purchase")!;
    expect(purchase.referenceIdentities()[0]!.enforce).toBe(false);
  });
});
