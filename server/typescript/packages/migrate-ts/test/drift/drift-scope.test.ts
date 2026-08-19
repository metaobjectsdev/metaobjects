/**
 * `meta verify --db` honours `migrate.scope` — the drift half.
 *
 * `computeDriftFromActual` is the single choke point for BOTH verify paths (the
 * Kysely path and the D1 path), so the scope is threaded there. A table another
 * owner's tool created is not this consumer's drift: it is reported as
 * out-of-scope rather than as a change, and `verify` says how many were skipped
 * (a table silently dropped from the comparison would read as a CHECKED table).
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { computeDriftFromActual } from "../../src/drift/drift.js";

const META = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Job",
          package: "acme::platform",
          children: [
            { "source.rdb": { name: "src", "@table": "jobs" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Match",
          package: "arena",
          children: [
            { "source.rdb": { name: "src", "@table": "matches" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

async function load(): Promise<MetaRoot> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
}

const platformOnly = (fqn: string): boolean => fqn.startsWith("acme::platform::");

describe("computeDriftFromActual — migrate.scope", () => {
  test("an out-of-scope table present in the DB is NOT drift", async () => {
    const root = await load();
    // The live database holds both tables; only `jobs` is this consumer's.
    const actual = buildExpectedSchema(root, { dialect: "sqlite" });

    const result = await computeDriftFromActual(actual, "sqlite", root, { inScope: platformOnly });
    expect(result.changes).toEqual([]);
    expect(result.outOfScope).toEqual(["public.matches"]);
  });

  test("in-scope drift is still reported", async () => {
    const root = await load();
    const actual = buildExpectedSchema(root, { dialect: "sqlite" });
    actual.tables = actual.tables.filter((t) => t.name !== "jobs");

    const result = await computeDriftFromActual(actual, "sqlite", root, { inScope: platformOnly });
    expect(result.changes.map((c) => c.kind)).toContain("create-table");
  });

  test("no scope → unchanged: every table is compared, nothing is out of scope", async () => {
    const root = await load();
    const actual = buildExpectedSchema(root, { dialect: "sqlite" });
    actual.tables = actual.tables.filter((t) => t.name !== "matches");

    const result = await computeDriftFromActual(actual, "sqlite", root);
    expect(result.changes.map((c) => c.kind)).toEqual(["create-table"]);
    expect(result.outOfScope).toEqual([]);
  });
});
