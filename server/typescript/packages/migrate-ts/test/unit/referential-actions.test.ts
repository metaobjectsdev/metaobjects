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
      { "source.rdb": {} },
      { "field.long": { name: "id" } },
      { "identity.primary": { "name": "id", "@fields": "id" } },
    ] } },
    { "object.entity": { name: "Week", children: [
      { "source.rdb": {} },
      { "field.long": { name: "id" } },
      { "field.long": { name: "programId" } },
      ...(rel ? [rel] : []),
      { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program" } },
      { "identity.primary": { "name": "id", "@fields": "id" } },
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

// ---------------------------------------------------------------------------
// Referential actions declared DIRECTLY on the identity.reference (the FK).
//
// Regression: an @onDelete / @onUpdate authored on the identity.reference was
// previously ignored — only a correlated relationship node supplied actions —
// so FKs declared with @onDelete: cascade emitted a bare FK (no ON DELETE),
// silently dropping cascade intent.
// ---------------------------------------------------------------------------

function weekDocRef(refAttrs: Record<string, unknown>, rel?: Record<string, unknown>) {
  return { "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Program", children: [
      { "source.rdb": {} },
      { "field.long": { name: "id" } },
      { "identity.primary": { "name": "id", "@fields": "id" } },
    ] } },
    { "object.entity": { name: "Week", children: [
      { "source.rdb": {} },
      { "field.long": { name: "id" } },
      { "field.long": { name: "programId" } },
      ...(rel ? [rel] : []),
      { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program", ...refAttrs } },
      { "identity.primary": { "name": "id", "@fields": "id" } },
    ] } },
  ] } };
}

async function loadWeekRef(refAttrs: Record<string, unknown>, rel?: Record<string, unknown>) {
  const { root, errors } = await loadDoc(weekDocRef(refAttrs, rel));
  expect(errors).toHaveLength(0);
  const week = root.objects().find((o) => o.name === "Week")!;
  const ref = week.referenceIdentities()[0]!;
  return { root, week, ref };
}

describe("reference-level @onDelete / @onUpdate (declared on identity.reference)", () => {
  test("reference @onDelete wins with no relationship; onUpdate stays absent", async () => {
    const { week, ref } = await loadWeekRef({ "@onDelete": "cascade" });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "cascade", onUpdate: undefined });
  });

  test("reference @onUpdate is honored independently", async () => {
    const { week, ref } = await loadWeekRef({ "@onDelete": "restrict", "@onUpdate": "cascade" });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });

  test("'setnull' is accepted as an alias for the canonical 'set-null'", async () => {
    const { week, ref } = await loadWeekRef({ "@onDelete": "setnull" });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "set-null", onUpdate: undefined });
  });

  test("reference @onDelete overrides a correlated relationship's action", async () => {
    const { week, ref } = await loadWeekRef(
      { "@onDelete": "restrict" },
      { "relationship.composition": { name: "program", "@objectRef": "Program", "@cardinality": "one" } },
    );
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });

  test("end-to-end: reference @onDelete: cascade → ON DELETE CASCADE (Postgres), no relationship node", async () => {
    const { root } = await loadWeekRef({ "@onDelete": "cascade" });
    const snapshot = buildExpectedSchema(root);
    const { changes } = await diff(snapshot, EMPTY_SCHEMA);
    const { up } = emit(changes, { dialect: "postgres" });
    expect(up).toContain('ADD CONSTRAINT "weeks_program_id_fk"');
    expect(up).toContain('REFERENCES "programs" ("id") ON DELETE CASCADE');
  });
});
