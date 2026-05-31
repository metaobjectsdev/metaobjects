// test/drift/drift-against-snapshot.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { driftAgainstSnapshot } from "../../src/drift/classify.js";

// Snapshot models {id, ref}; the live DB has {id, note} — i.e. it dropped `ref`
// (real drift) and gained an unmanaged `note`.
const ENTITY = (fields: string) =>
  JSON.stringify({
    "metadata.root": {
      children: [{
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            ...JSON.parse(fields),
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      }],
    },
  });

async function snapshotOf(fields: string) {
  const root: MetaData = (await new MetaDataLoader().load([new InMemoryStringSource(ENTITY(fields))])).root;
  return buildExpectedSchema(root, { dialect: "postgres" });
}

describe("driftAgainstSnapshot", () => {
  test("missing modeled column = drift; extra DB column = unmanaged", async () => {
    const snapshot = await snapshotOf('[{"field.string":{"name":"ref"}}]');
    const liveDb = await snapshotOf('[{"field.string":{"name":"note"}}]');
    const { drift, unmanaged } = await driftAgainstSnapshot(snapshot, liveDb);

    // snapshot has `ref` the DB lacks → add-column drift
    expect(drift.some((c) => c.kind === "add-column")).toBe(true);
    // DB has `note` the snapshot lacks → drop-column unmanaged
    expect(unmanaged.some((c) => c.kind === "drop-column")).toBe(true);
    expect(drift.some((c) => c.kind === "drop-column")).toBe(false);
  });

  test("identical schemas → no drift, no unmanaged", async () => {
    const snap = await snapshotOf('[{"field.string":{"name":"ref"}}]');
    const { drift, unmanaged } = await driftAgainstSnapshot(snap, snap);
    expect(drift).toEqual([]);
    expect(unmanaged).toEqual([]);
  });
});
