/**
 * D3 — a view the migration recreates only around a table change is not drift.
 *
 * `diff` still plans the drop/create pair (the migration SQL needs it), but a drift report
 * answers "does the database match the metadata?", and a view whose definition matches
 * does. An adopter's `verify --db` listed every report and projection view as
 * `- view` / `+ view` because the tables under them had unrelated drift.
 */
import { test, expect, describe } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { computeDriftFromActual } from "../../src/drift/drift.js";
import { classifyDrift } from "../../src/drift/classify.js";
import type { Change, Dialect, SchemaSnapshot } from "../../src/types.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::d3",
    children: [
      {
        "object.entity": {
          name: "Gadget",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "label", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

async function loadMeta() {
  return (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
}

describe("D3 — computeDriftFromActual leaves recreate-only views out of the drift", () => {
  for (const dialect of ["sqlite", "d1", "postgres"] as const satisfies readonly Dialect[]) {
    test(`${dialect}: a table difference is drift; the matching view over it is not`, async () => {
      const root = await loadMeta();
      const probe = buildExpectedSchema(root, { dialect });
      const table = probe.tables[0]!;
      const body = `SELECT id, label FROM ${table.name}`;
      const views = [{ name: "v_gadget", sql: body, dependsOn: [table.name] }];
      const expected = buildExpectedSchema(root, { dialect, views });
      const view = expected.views[0]!;

      // The database: the view exactly as the metadata declares it, and `label` nullable.
      const actual: SchemaSnapshot = structuredClone(expected);
      actual.tables[0]!.columns.find((c) => c.name === "label")!.nullable = true;
      actual.views = [
        dialect === "postgres"
          ? { name: view.name, sql: " SELECT gadget.id, gadget.label FROM gadget;", fingerprint: view.fingerprint! }
          : { name: view.name, sql: `CREATE VIEW "${view.name}" AS ${body}` },
      ];

      const result = await computeDriftFromActual(actual, dialect, root, { views });
      expect(result.changes.map((c) => c.kind)).toEqual(["change-column-nullable"]);
      expect(result.blocked.some((c) => c.kind === "drop-view" || c.kind === "create-view")).toBe(false);
    });
  }
});

describe("D3 — classifyDrift leaves recreate-only views out of both buckets", () => {
  test("an unchanged recreate pair is neither drift nor unmanaged", () => {
    const allowed = { state: "allowed" as const };
    const reason = { kind: "unchanged" as const, tables: ["t"] };
    const changes: Change[] = [
      { kind: "change-column-nullable", table: "t", column: "c", from: true, to: false, status: allowed },
      { kind: "drop-view", view: "v", reason, status: allowed },
      { kind: "create-view", view: { name: "v", sql: "SELECT c FROM t" }, reason, status: allowed },
      { kind: "drop-view", view: "legacy", reason: { kind: "undeclared" }, status: allowed },
    ];
    const { drift, unmanaged } = classifyDrift(changes);
    expect(drift.map((c) => c.kind)).toEqual(["change-column-nullable"]);
    expect(unmanaged).toMatchObject([{ kind: "drop-view", view: "legacy" }]);
  });
});
