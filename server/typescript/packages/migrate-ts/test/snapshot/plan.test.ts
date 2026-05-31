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

describe("baselineFromMetadata", () => {
  test("equals buildExpectedSchema for the dialect", async () => {
    const metadata = await loadJson(META);
    const snap = baselineFromMetadata(metadata, "postgres");
    expect(snap.tables.map((t) => t.name)).toEqual(["orders"]);
  });
});
