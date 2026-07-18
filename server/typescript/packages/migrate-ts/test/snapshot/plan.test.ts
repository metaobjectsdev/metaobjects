// test/snapshot/plan.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import type { SchemaSnapshot } from "../../src/types.js";
import { planOffline, baselineFromMetadata } from "../../src/snapshot/plan.js";

const META = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "ref" } },
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadJson(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

const EMPTY: SchemaSnapshot = { tables: [], views: [] };

describe("planOffline", () => {
  test("against an empty snapshot emits create-table and returns the new snapshot", async () => {
    const metadata = await loadJson(META);
    const { diff, nextSnapshot } = await planOffline({ metadata, dialect: "postgres", snapshot: EMPTY });
    expect(diff.changes.some((c) => c.kind === "create-table")).toBe(true);
    expect(nextSnapshot.tables).toHaveLength(1);
    expect(nextSnapshot.tables[0]?.name).toBe("orders");
  });

  test("against the current baseline emits no changes (reflexive)", async () => {
    const metadata = await loadJson(META);
    const snapshot = baselineFromMetadata(metadata, "postgres");
    const { diff } = await planOffline({ metadata, dialect: "postgres", snapshot });
    expect(diff.changes).toHaveLength(0);
  });
});

describe("planOffline — #208 @unmanaged (offline DROP suppression)", () => {
  const legacyMeta = (unmanaged: boolean) =>
    JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Legacy",
              children: [
                { "field.long": { name: "id" } },
                {
                  "source.rdb": {
                    name: "src",
                    "@table": "legacy_accounts",
                    ...(unmanaged ? { "@unmanaged": true } : {}),
                  },
                },
                { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    });

  test("does NOT propose drop-table for an @unmanaged table captured in the snapshot (a from-db baseline)", async () => {
    // A `baseline --from-db` captured the Flyway-owned table into the committed snapshot...
    const snapshot = baselineFromMetadata(await loadJson(legacyMeta(false)), "postgres");
    expect(snapshot.tables.map((t) => t.name)).toContain("legacy_accounts");

    // ...and the metadata now declares that table @unmanaged. The offline generate path
    // must stay silent for it — not propose DROP for an externally-owned table.
    const metadata = await loadJson(legacyMeta(true));
    const { diff } = await planOffline({ metadata, dialect: "postgres", snapshot });
    expect(diff.changes.some((c) => c.kind === "drop-table" && c.table === "legacy_accounts")).toBe(false);
    expect(diff.changes).toHaveLength(0);
  });
});

describe("baselineFromMetadata", () => {
  test("equals buildExpectedSchema for the dialect", async () => {
    const metadata = await loadJson(META);
    const snap = baselineFromMetadata(metadata, "postgres");
    expect(snap.tables.map((t) => t.name)).toEqual(["orders"]);
  });
});
