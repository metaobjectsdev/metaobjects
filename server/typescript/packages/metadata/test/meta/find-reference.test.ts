import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, findReferenceBetween } from "@metaobjectsdev/metadata";
import type { MetaObject } from "@metaobjectsdev/metadata";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

describe("findReferenceBetween", () => {
  test("belongs-to: reference on source side (Purchase -> Program)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "field.long":   { name: "id" } },
            { "field.string": { name: "title" } },
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

    const program = root.objects().find((o) => o.name === "Program") as MetaObject;
    const purchase = root.objects().find((o) => o.name === "Purchase") as MetaObject;

    const lookup = findReferenceBetween(purchase, program);
    expect(lookup).toBeDefined();
    expect(lookup!.holder.name).toBe("Purchase");
    expect(lookup!.other.name).toBe("Program");
    expect(lookup!.referenceIdentity.fields).toEqual(["programId"]);
    expect(lookup!.referenceIdentity.targetEntity).toBe("Program");
  });

  test("has-many: reference on child side (Program -> Week)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Week",
          children: [
            { "field.long": { name: "id" } },
            { "field.long": { name: "programId" } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
          ],
        },
      },
    ]);

    const program = root.objects().find((o) => o.name === "Program") as MetaObject;
    const week = root.objects().find((o) => o.name === "Week") as MetaObject;

    // Order-independent: calling with (Program, Week) should find the reference on Week.
    const lookup = findReferenceBetween(program, week);
    expect(lookup).toBeDefined();
    expect(lookup!.holder.name).toBe("Week");
    expect(lookup!.other.name).toBe("Program");
    expect(lookup!.referenceIdentity.fields).toEqual(["programId"]);
  });

  test("no reference declared: returns undefined", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "A",
          children: [
            { "field.long": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "B",
          children: [
            { "field.long": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
    ]);

    const a = root.objects().find((o) => o.name === "A") as MetaObject;
    const b = root.objects().find((o) => o.name === "B") as MetaObject;

    expect(findReferenceBetween(a, b)).toBeUndefined();
  });
});
