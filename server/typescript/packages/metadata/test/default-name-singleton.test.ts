import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import type { MetaObject } from "../src/core/object/meta-object.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  const result = await loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "t.json" }),
  ]);
  return { loader, ...result };
}

const ENTITY = (identityChildren: unknown[]) => ({
  "metadata.root": {
    package: "t",
    children: [
      { "object.entity": { name: "A", children: [
        { "field.long": { name: "id" } },
        { "field.string": { name: "email" } },
        ...identityChildren,
      ] } },
    ],
  },
});

describe("config-driven default name (singleton child types)", () => {
  test("identity.primary with NO name defaults to 'primary' and loads clean", async () => {
    const { loader, errors } = await load(
      ENTITY([{ "identity.primary": { "@fields": ["id"], "@generation": "increment" } }]),
    );
    expect(errors).toEqual([]);
    const a = loader.findByTypeAndName("object", "A") as MetaObject;
    const pk = a.identities()[0]!;
    expect(pk.name).toBe("primary");
  });

  test("explicit name on identity.primary is still honored", async () => {
    const { loader, errors } = await load(
      ENTITY([{ "identity.primary": { name: "pk", "@fields": ["id"] } }]),
    );
    expect(errors).toEqual([]);
    const a = loader.findByTypeAndName("object", "A") as MetaObject;
    expect(a.identities()[0]!.name).toBe("pk");
  });

  test("two identity.primary under one entity → ERR_TOO_MANY_OCCURRENCES (maxOccurs:1 enforced)", async () => {
    const { errors } = await load(
      ENTITY([
        { "identity.primary": { name: "p1", "@fields": ["id"] } },
        { "identity.primary": { name: "p2", "@fields": ["email"] } },
      ]),
    );
    expect(errors.some((e) => e.message.includes("identity.primary appears 2 times"))).toBe(true);
  });

  test("identity.secondary with NO name still errors (not a singleton — no defaultName)", async () => {
    const { errors } = await load(
      ENTITY([
        { "identity.primary": { "@fields": ["id"] } },
        { "identity.secondary": { "@fields": ["email"], "@unique": true } },
      ]),
    );
    expect(errors.some((e) => e.message.includes("has no name"))).toBe(true);
  });
});
