import { describe, expect, test } from "bun:test";
import { resolveReferentialActions } from "../../src/referential-actions.js";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import { MetaDataLoader, InMemoryStringSource, REFERENTIAL_ACTIONS } from "@metaobjectsdev/metadata";

// Invariant referenced by the as-FkAction cast in resolveReferentialActions:
// REFERENTIAL_ACTIONS (metadata) and FkAction (migrate-ts) MUST be the same
// four-value kebab-case set. Tested here so a cross-package divergence is
// caught immediately rather than silently shipping wrong DDL.
describe("REFERENTIAL_ACTIONS / FkAction invariant", () => {
  test("REFERENTIAL_ACTIONS is exactly the FkAction union literal set", () => {
    expect([...REFERENTIAL_ACTIONS].sort()).toEqual(
      ["cascade", "no-action", "restrict", "set-null"],
    );
  });
});

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
}

function weekDoc(rel: Record<string, unknown> | undefined) {
  return { "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Program", children: [
      { "field.long": { name: "id" } },
      { "identity.primary": { "@fields": "id" } },
    ] } },
    { "object.entity": { name: "Week", children: [
      { "field.long": { name: "id" } },
      { "field.long": { name: "programId" } },
      ...(rel ? [rel] : []),
      { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program" } },
      { "identity.primary": { "@fields": "id" } },
    ] } },
  ] } };
}

async function loadWeek(rel: Record<string, unknown> | undefined) {
  const { root, errors } = await loadDoc(weekDoc(rel));
  expect(errors).toHaveLength(0);
  const week = root.objects().find((o) => o.name === "Week")!;
  const ref = week.referenceIdentities()[0]!;
  return { week, ref };
}

describe("resolveReferentialActions", () => {
  test("composition → cascade / cascade(default)", async () => {
    const { week, ref } = await loadWeek({
      "relationship.composition": { name: "program", "@objectRef": "Program", "@cardinality": "one" }
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "cascade", onUpdate: "cascade" });
  });

  test("aggregation → set-null / cascade(default)", async () => {
    const { week, ref } = await loadWeek({
      "relationship.aggregation": { name: "program", "@objectRef": "Program", "@cardinality": "one" }
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "set-null", onUpdate: "cascade" });
  });

  test("association → restrict / cascade(default)", async () => {
    const { week, ref } = await loadWeek({
      "relationship.association": { name: "program", "@objectRef": "Program", "@cardinality": "one" }
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });

  test("explicit override wins; no-action normalizes to undefined", async () => {
    const { week, ref } = await loadWeek({
      "relationship.composition": { name: "program", "@objectRef": "Program",
          "@onDelete": "set-null", "@onUpdate": "no-action" }
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "set-null", onUpdate: undefined });
  });

  test("no correlated relationship → both undefined", async () => {
    const { week, ref } = await loadWeek(undefined);
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: undefined, onUpdate: undefined });
  });
});

// ---------------------------------------------------------------------------
// Round-trip: buildExpectedSchema → diff (against empty) → emit
//
// Asserts that the relationship-derived defaults (and explicit overrides)
// flow all the way through to the emitted DDL — for both Postgres
// (ALTER TABLE … ADD CONSTRAINT) and SQLite (inline FOREIGN KEY clause).
// ---------------------------------------------------------------------------

const EMPTY_SCHEMA = { tables: [], views: [] };

async function buildSnapshotForRel(rel: Record<string, unknown>) {
  const { root, errors } = await loadDoc(weekDoc(rel));
  expect(errors).toHaveLength(0);
  return buildExpectedSchema(root);
}

describe("end-to-end FK actions in emitted DDL", () => {
  test("composition default → ON DELETE CASCADE / ON UPDATE CASCADE (Postgres ADD CONSTRAINT)", async () => {
    const snapshot = await buildSnapshotForRel({
      "relationship.composition": { name: "program", "@objectRef": "Program", "@cardinality": "one" },
    });
    const { changes } = await diff(snapshot, EMPTY_SCHEMA);
    const { up } = emit(changes, { dialect: "postgres" });
    expect(up).toContain('ADD CONSTRAINT "weeks_program_id_fk"');
    expect(up).toContain('REFERENCES "programs" ("id") ON DELETE CASCADE ON UPDATE CASCADE');
  });

  test("composition default → inline FOREIGN KEY … ON DELETE CASCADE ON UPDATE CASCADE (SQLite CREATE TABLE)", async () => {
    const snapshot = await buildSnapshotForRel({
      "relationship.composition": { name: "program", "@objectRef": "Program", "@cardinality": "one" },
    });
    const { changes } = await diff(snapshot, EMPTY_SCHEMA);
    const { up } = emit(changes, { dialect: "sqlite" });
    expect(up).toContain('FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE CASCADE ON UPDATE CASCADE');
  });

  test("explicit @onDelete: set-null overrides composition default; @onUpdate stays cascade (Postgres)", async () => {
    const snapshot = await buildSnapshotForRel({
      "relationship.composition": {
        name: "program", "@objectRef": "Program", "@cardinality": "one",
        "@onDelete": "set-null", "@onUpdate": "cascade",
      },
    });
    const { changes } = await diff(snapshot, EMPTY_SCHEMA);
    const { up } = emit(changes, { dialect: "postgres" });
    expect(up).toContain('REFERENCES "programs" ("id") ON DELETE SET NULL ON UPDATE CASCADE');
    expect(up).not.toContain("ON DELETE CASCADE");
  });

  test("explicit @onDelete: set-null overrides composition default (SQLite inline)", async () => {
    const snapshot = await buildSnapshotForRel({
      "relationship.composition": {
        name: "program", "@objectRef": "Program", "@cardinality": "one",
        "@onDelete": "set-null", "@onUpdate": "cascade",
      },
    });
    const { changes } = await diff(snapshot, EMPTY_SCHEMA);
    const { up } = emit(changes, { dialect: "sqlite" });
    expect(up).toContain('FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE SET NULL ON UPDATE CASCADE');
  });
});
