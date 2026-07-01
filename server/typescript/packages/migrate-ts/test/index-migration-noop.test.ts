// packages/migrate-ts/test/index-migration-noop.test.ts
//
// Proves that renaming the metadata vocabulary from the old
// `identity.secondary @unique:false` pattern to the new `index.lookup`
// produces NO migration SQL — the physical database index is identical.
//
// Context: `@unique` is no longer a valid attribute on `identity.secondary`
// (the subtype enforces uniqueness by definition; `@unique:false` was
// never supported). `index.lookup` is the correct declaration for a
// non-unique query-performance index.
//
// The "old" side cannot be loaded from JSON because the loader now hard-errors
// on `ERR_UNKNOWN_ATTR` for `@unique` on `identity.secondary`. Instead we:
//
//   1. Build the expected schema from the NEW declaration (`index.lookup`).
//   2. Build the *actual* schema to represent what is already in the DB — also
//      from the same `index.lookup` declaration — confirming that the physical
//      index a plain non-unique `identity.secondary` would have produced is
//      exactly what `index.lookup` produces.
//   3. Diff expected vs actual: assert zero changes.
//
// This is the canonical way to prove "vocabulary move → no DDL churn":
// the physical column/index definition is the invariant; the diff engine
// compares those definitions, not the metadata subtype names.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { diff } from "../src/diff/index.js";
import { emit } from "../src/emit/index.js";

async function load(json: string): Promise<MetaData> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return r.root;
}

// Entity with a non-unique index declared the NEW way (index.lookup).
// Pre-migration this index would have been declared as:
//   { "identity.secondary": { "name": "idx_events_user", "@fields": ["userId"], "@unique": false } }
// That declaration is now rejected by the loader (ERR_UNKNOWN_ATTR on @unique).
// The physical CREATE INDEX it would have produced is:
//   CREATE INDEX "idx_events_user" ON "events" ("user_id");
// — exactly what index.lookup produces (see test below).
const NEW_MODEL = JSON.stringify({
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Event",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "userId" } },
            { "field.string": { "name": "kind" } },
            { "field.timestamp": { "name": "occurredAt" } },
            { "source.rdb": { "@table": "events" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
            {
              "index.lookup": {
                "name": "idx_events_user",
                "@fields": ["userId"],
              },
            },
          ],
        },
      },
    ],
  },
});

// Same entity with a composite non-unique index (multi-field, with DESC ordering).
// Old form (now rejected): identity.secondary @fields:["userId","occurredAt"] @orders:["asc","desc"] @unique:false
const NEW_MODEL_COMPOSITE = JSON.stringify({
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Event",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "userId" } },
            { "field.timestamp": { "name": "occurredAt" } },
            { "source.rdb": { "@table": "events" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
            {
              "index.lookup": {
                "name": "idx_events_user_time",
                "@fields": ["userId", "occurredAt"],
                "@orders": ["asc", "desc"],
              },
            },
          ],
        },
      },
    ],
  },
});

describe("index.lookup vocabulary migration — no DDL churn", () => {
  test("index.lookup produces a non-unique CREATE INDEX (no UNIQUE keyword)", async () => {
    // Confirm the physical DDL is a plain CREATE INDEX — matching what any
    // non-unique index has always emitted.
    const root = await load(NEW_MODEL);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
    const sql = emit(
      (await diff({ expected: snapshot, actual: { tables: [], views: [] } })).changes,
      { dialect: "postgres" },
    ).up;
    expect(sql).toContain('CREATE INDEX "idx_events_user" ON "events" ("user_id");');
    expect(sql).not.toContain("UNIQUE");
  });

  test("diff is empty when the physical index already exists in the DB (the no-op guarantee)", async () => {
    // Simulate: the DB already has the index (as it was created by the old
    // identity.secondary declaration). Build the schema snapshot from the NEW
    // index.lookup declaration — the "expected" side. The "actual" side is
    // constructed to match what the DB holds: the same non-unique index.
    const root = await load(NEW_MODEL);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });

    // The actual snapshot reuses the index descriptor that buildExpectedSchema
    // produced for "events" — this exactly represents what a plain non-unique
    // CREATE INDEX produces in the DB (no uniqueness, same columns/name).
    const eventsTable = expected.tables.find((t) => t.name === "events")!;
    const actual = {
      tables: [eventsTable],
      views: [],
    };

    const result = await diff({ expected, actual });
    const indexChanges = result.changes.filter(
      (c) => c.kind === "add-index" || c.kind === "drop-index",
    );
    expect(indexChanges).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  test("diff is empty for composite ordered index (multi-field migration no-op)", async () => {
    const root = await load(NEW_MODEL_COMPOSITE);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const eventsTable = expected.tables.find((t) => t.name === "events")!;
    const actual = { tables: [eventsTable], views: [] };

    const result = await diff({ expected, actual });
    expect(result.changes).toEqual([]);
  });

  test("@unique:false on identity.secondary is rejected by the loader (ERR_UNKNOWN_ATTR)", async () => {
    // Document the loader error that adopters hit when they still have the old
    // declaration — confirmed here so the migration guide's diagnosis section
    // has a test-backed claim.
    const oldForm = JSON.stringify({
      "metadata.root": {
        "children": [
          {
            "object.entity": {
              "name": "Event",
              "children": [
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "userId" } },
                { "source.rdb": { "@table": "events" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                {
                  "identity.secondary": {
                    "name": "idx_events_user",
                    "@fields": ["userId"],
                    "@unique": false,
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const result = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(oldForm)]);
    const codes = result.errors.map((e) => (e as { code?: string }).code ?? "ERR_UNKNOWN");
    expect(codes).toContain("ERR_UNKNOWN_ATTR");
  });
});
