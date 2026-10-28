// `entityTypeNames` is the contract for the six type names the entity module exports, and
// docs/ports/typescript.md lists them. The golden snapshot is the emitted truth: every name
// the helper returns for an entity must be exported by that entity's module, so the table
// cannot fall behind the generator.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import { entityTypeNames } from "../src/index.js";

const GOLDEN = join(import.meta.dirname, "golden", "__snapshots__", "sqlite");

async function entity(name: string) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({
        metadata: { package: "t", children: [{ "object.entity": { name, children: [{ "field.long": { name: "id" } }] } }] },
      }),
      { id: "m.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root.objects()[0]!;
}

describe("entityTypeNames", () => {
  test("spells the six names from the entity name", async () => {
    expect(entityTypeNames(await entity("Subscriber"))).toEqual({
      row: "Subscriber",
      insert: "SubscriberInsert",
      update: "SubscriberUpdate",
      create: "SubscriberCreate",
      patch: "SubscriberPatch",
      filter: "SubscriberFilter",
    });
  });

  test("a TPH discriminator base keeps the bare name for its union and reads rows as <Entity>Row", async () => {
    expect(entityTypeNames(await entity("Vehicle"), { tphBase: true }).row).toBe("VehicleRow");
  });

  test("every name is a type exported by the golden Subscriber module", async () => {
    const source = readFileSync(join(GOLDEN, "Subscriber.ts"), "utf8");
    for (const [role, name] of Object.entries(entityTypeNames(await entity("Subscriber")))) {
      expect(source, role).toMatch(new RegExp(`^export type ${name}\\b`, "m"));
    }
  });
});
