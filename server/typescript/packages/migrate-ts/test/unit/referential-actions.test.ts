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

// DURABLE INVARIANT — any model `meta migrate` accepts must also load under
// strict `meta verify` (ADR-0047). Every model this file feeds the migrate
// engine loads with `strict: true`, so a migrate-honored-but-unregistered attr
// (the exact hole that let identity.reference @onDelete/@onUpdate ship
// unregistered) fails THIS suite instead of an adopter's verify run.
async function loadDoc(doc: unknown) {
  return new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(JSON.stringify(doc))]);
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

// ---------------------------------------------------------------------------
// PARENT-side relationship correlation (the documented authoring shape).
//
// Regression: the docs + authoring skill teach declaring the relationship on
// the PARENT ("Program owns weeks": relationship.composition { @objectRef:
// "Week", @cardinality: "many" } on Program), but the correlation only scanned
// relationships declared on the FK-OWNING child — so the documented
// "composition ⇒ ON DELETE CASCADE default" silently never fired and deleting
// a parent with children hit a bare-FK restrict at runtime.
// ---------------------------------------------------------------------------

function parentSideDoc(
  parentRel: Record<string, unknown> | undefined,
  opts?: {
    childRel?: Record<string, unknown>;
    childRefAttrs?: Record<string, unknown>;
    extraChildChildren?: Record<string, unknown>[];
  },
) {
  return { "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Program", children: [
      { "source.rdb": {} },
      { "field.long": { name: "id" } },
      { "identity.primary": { "name": "id", "@fields": "id" } },
      ...(parentRel ? [parentRel] : []),
    ] } },
    { "object.entity": { name: "Week", children: [
      { "source.rdb": {} },
      { "field.long": { name: "id" } },
      { "field.long": { name: "programId" } },
      ...(opts?.childRel ? [opts.childRel] : []),
      { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program", ...(opts?.childRefAttrs ?? {}) } },
      ...(opts?.extraChildChildren ?? []),
      { "identity.primary": { "name": "id", "@fields": "id" } },
    ] } },
  ] } };
}

async function loadParentSide(
  parentRel: Record<string, unknown> | undefined,
  opts?: Parameters<typeof parentSideDoc>[1],
) {
  const { root, errors } = await loadDoc(parentSideDoc(parentRel, opts));
  expect(errors).toHaveLength(0);
  const week = root.objects().find((o) => o.name === "Week")!;
  const ref = week.referenceIdentities()[0]!;
  return { root, week, ref };
}

describe("parent-side relationship correlation (reverse relationship on the FK target)", () => {
  test("parent-side many composition → cascade / cascade(default)", async () => {
    const { week, ref } = await loadParentSide({
      "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" },
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "cascade", onUpdate: "cascade" });
  });

  test("parent-side many aggregation → set-null / cascade(default)", async () => {
    const { week, ref } = await loadParentSide({
      "relationship.aggregation": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" },
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "set-null", onUpdate: "cascade" });
  });

  test("parent-side one composition (1:1) also correlates", async () => {
    const { week, ref } = await loadParentSide({
      "relationship.composition": { name: "week", "@objectRef": "Week", "@cardinality": "one" },
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "cascade", onUpdate: "cascade" });
  });

  test("explicit @onDelete on the parent-side relationship wins over its subtype default", async () => {
    const { week, ref } = await loadParentSide({
      "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many", "@onDelete": "restrict" },
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });

  test("FQN @objectRef on the parent side correlates too", async () => {
    const { week, ref } = await loadParentSide({
      "relationship.composition": { name: "weeks", "@objectRef": "acme::Week", "@cardinality": "many" },
    });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "cascade", onUpdate: "cascade" });
  });

  test("a CHILD-side relationship still wins over a parent-side one", async () => {
    const { week, ref } = await loadParentSide(
      { "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
      { childRel: { "relationship.association": { name: "program", "@objectRef": "Program", "@cardinality": "one" } } },
    );
    // association (child-side) default restrict — NOT the parent composition's cascade.
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });

  test("reference-level @onDelete still wins over a parent-side relationship", async () => {
    const { week, ref } = await loadParentSide(
      { "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
      { childRefAttrs: { "@onDelete": "restrict" } },
    );
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });

  test("an M:N @through relationship on the parent does NOT correlate to a direct FK", async () => {
    // Program -[many @through Enrollment]-> Week describes the junction path;
    // it must not arm actions on Week's own direct FK to Program.
    const doc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many", "@through": "Enrollment" } },
      ] } },
      { "object.entity": { name: "Week", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId" } },
        { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Enrollment", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId" } },
        { "field.long": { name: "weekId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "programRef", "@fields": ["programId"], "@references": "Program" } },
        { "identity.reference": { name: "weekRef", "@fields": ["weekId"], "@references": "Week" } },
      ] } },
    ] } };
    const { root, errors } = await loadDoc(doc);
    expect(errors).toHaveLength(0);
    const week = root.objects().find((o) => o.name === "Week")!;
    const ref = week.referenceIdentities()[0]!;
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: undefined, onUpdate: undefined });
  });

  test("ambiguous: two FKs to the same parent → the parent-side relationship contributes nothing", async () => {
    // Week has TWO references to Program; "Program owns weeks" cannot say which
    // FK carries the ownership edge, so arming both would cascade through an
    // edge the author never designated. Fail closed: no action on either.
    const { root, errors } = await loadDoc(parentSideDoc(
      { "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
      { extraChildChildren: [
        { "field.long": { name: "altProgramId" } },
        { "identity.reference": { name: "ref_alt_program", "@fields": ["altProgramId"], "@references": "Program" } },
      ] },
    ));
    expect(errors).toHaveLength(0);
    const week = root.objects().find((o) => o.name === "Week")!;
    for (const ref of week.referenceIdentities()) {
      expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: undefined, onUpdate: undefined });
    }
  });

  test("no relationship on either side → still no action", async () => {
    const { week, ref } = await loadParentSide(undefined);
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: undefined, onUpdate: undefined });
  });

  test("INFERRED parent-side aggregation set-null on a @required FK contributes nothing (byte-compat)", async () => {
    // The set-null DEFAULT is unsatisfiable on a NOT NULL column. An inferred
    // default must never turn a previously-valid model into a hard error, so
    // the reverse correlation fails closed and the FK stays bare.
    const doc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "relationship.aggregation": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
      ] } },
      { "object.entity": { name: "Week", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId", "@required": true } },
        { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
      ] } },
    ] } };
    const { root, errors } = await loadDoc(doc);
    expect(errors).toHaveLength(0);
    const week = root.objects().find((o) => o.name === "Week")!;
    const ref = week.referenceIdentities()[0]!;
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: undefined, onUpdate: undefined });
    // And buildExpectedSchema does not throw — the model stays buildable.
    expect(() => buildExpectedSchema(root)).not.toThrow();
  });

  test("EXPLICIT parent-side @onDelete: set-null on a @required FK still errors loudly", async () => {
    // The author asked for set-null; silently dropping it would be the original
    // bug. The resolved action flows into validateSetNullNullability.
    const doc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "relationship.aggregation": { name: "weeks", "@objectRef": "Week", "@cardinality": "many", "@onDelete": "set-null" } },
      ] } },
      { "object.entity": { name: "Week", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId", "@required": true } },
        { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
      ] } },
    ] } };
    const { root, errors } = await loadDoc(doc);
    expect(errors).toHaveLength(0);
    expect(() => buildExpectedSchema(root)).toThrow(/set-null|SET NULL|NOT NULL/i);
  });

  test("end-to-end: parent-side many composition → ON DELETE CASCADE lands on the child FK (Postgres)", async () => {
    const { root } = await loadParentSide({
      "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" },
    });
    const snapshot = buildExpectedSchema(root);
    const { changes } = await diff(snapshot, EMPTY_SCHEMA);
    const { up } = emit(changes, { dialect: "postgres" });
    expect(up).toContain('ADD CONSTRAINT "weeks_program_id_fk"');
    expect(up).toContain('REFERENCES "programs" ("id") ON DELETE CASCADE ON UPDATE CASCADE');
  });

  test("end-to-end: parent-side many composition → inline FK actions (SQLite)", async () => {
    const { root } = await loadParentSide({
      "relationship.composition": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" },
    });
    const snapshot = buildExpectedSchema(root);
    const { changes } = await diff(snapshot, EMPTY_SCHEMA);
    const { up } = emit(changes, { dialect: "sqlite" });
    expect(up).toContain('FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE CASCADE ON UPDATE CASCADE');
  });
});

describe("reference-level @onDelete / @onUpdate (declared on identity.reference)", () => {
  test("reference @onDelete wins with no relationship; onUpdate stays absent", async () => {
    const { week, ref } = await loadWeekRef({ "@onDelete": "cascade" });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "cascade", onUpdate: undefined });
  });

  test("reference @onUpdate is honored independently", async () => {
    const { week, ref } = await loadWeekRef({ "@onDelete": "restrict", "@onUpdate": "cascade" });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });

  test("legacy 'setnull' alias is retired — fails load with ERR_BAD_ATTR_VALUE (ADR-0047)", async () => {
    // Pre-registration, the alias slipped through as an unregistered attr on a
    // lax load. Now the attr is registered with allowedValues, so the alias is
    // rejected at load in BOTH the migrate (lax) and verify (strict) pipelines.
    for (const strict of [false, true]) {
      const { errors } = await new MetaDataLoader({ strict }).load([
        new InMemoryStringSource(JSON.stringify(weekDocRef({ "@onDelete": "setnull" }))),
      ]);
      expect(errors.map((e) => e.message).join("\n")).toContain("not one of the allowed values");
    }
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
