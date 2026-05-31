// test/check/e2e-check.test.ts
//
// End-to-end regression coverage for CHECK constraints derived from field.enum.
// The unit tests exercised diff/emit in isolation and missed three correctness
// bugs (duplicate emit on postgres, sqlite throw, non-idempotent introspect path).
// These tests run the real pipeline: metadata → buildExpectedSchema → diff → emit.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import { baselineFromMetadata, planOffline } from "../../src/snapshot/plan.js";
import type { Dialect } from "../../src/types.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

const META = JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED"] } },
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});

const EMPTY = { tables: [], views: [] } as const;

describe("CHECK constraints — end-to-end (enum → CHECK)", () => {
  test("(a) new postgres table inlines the CHECK exactly once, no ADD CONSTRAINT", async () => {
    const meta = await load(META);
    const expected = buildExpectedSchema(meta, { dialect: "postgres" });
    const { changes } = await diff(expected, EMPTY);
    const { up } = emit(changes, { dialect: "postgres" });

    const checkCount = up.split("CHECK (").length - 1;
    expect(checkCount).toBe(1);
    expect(up).toContain(`CHECK (status IN ('OPEN', 'CLOSED'))`);
    expect(up).not.toContain("ADD CONSTRAINT");
  });

  test("(b) new sqlite table inlines the CHECK exactly once, does not throw", async () => {
    const meta = await load(META);
    const expected = buildExpectedSchema(meta, { dialect: "sqlite" });
    const { changes } = await diff(expected, EMPTY);

    let up = "";
    expect(() => {
      up = emit(changes, { dialect: "sqlite" }).up;
    }).not.toThrow();

    const checkCount = up.split("CHECK (").length - 1;
    expect(checkCount).toBe(1);
    expect(up).toContain(`CHECK (status IN ('OPEN', 'CLOSED'))`);
    expect(up).not.toContain("not implemented");
  });

  test.each<Dialect>(["postgres", "sqlite"])(
    "(c) steady-state idempotency: baseline-then-generate is a no-op (%s)",
    async (dialect) => {
      const meta = await load(META);
      const snapshot = baselineFromMetadata(meta, dialect);
      const { diff: result } = await planOffline({ metadata: meta, dialect, snapshot });
      expect(result.changes).toHaveLength(0);
    },
  );
});
