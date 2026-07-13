// buildProjectionViews — read-only source KINDS. Regression coverage for the
// migrate-pipeline crash/mis-emit on non-plain-view projections:
//
//   - @kind: storedProc / tableFunction — these are FR-015 CALLABLES, not views.
//     They are base-less (no extends-bound identity), so extractViewSpec THREW
//     ("cannot derive the base entity") and — because the CLI calls
//     buildProjectionViews unconditionally — `meta migrate` CRASHED OUTRIGHT for
//     any model containing one.
//
//   - @kind: materializedView — ViewSpec carries no source kind and the emitter
//     hardcoded CREATE VIEW, so a matview projection silently created a PLAIN
//     view (or, with the matview already in the DB, re-proposed create-view on
//     every run and the apply died on "already exists"). The migrate pipeline
//     cannot manage matviews today (no CREATE MATERIALIZED VIEW emit, and PG
//     introspection cannot even see them — information_schema.views excludes
//     matviews — so convergence is impossible). They are treated as
//     HAND-MANAGED, like the documented custom-SQL-view exception: skipped here,
//     neither created nor dropped by migrate.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children } });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

const MODEL: unknown[] = [
  {
    "object.entity": {
      name: "Program",
      children: [
        { "source.rdb": { "@table": "programs" } },
        { "field.int": { name: "id" } },
        { "field.string": { name: "title" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ],
    },
  },
  // Plain-view projection — the ONE kind the migrate view pipeline manages.
  {
    "object.projection": {
      name: "ProgramView",
      children: [
        { "source.rdb": { "@kind": "view", "@view": "v_programs" } },
        { "field.int": { name: "id", extends: "acme::Program.id" } },
        { "field.string": { name: "title", extends: "acme::Program.title" } },
        { "identity.primary": { name: "id", extends: "acme::Program.id" } },
      ],
    },
  },
  // FR-015 stored-proc projection: base-less, @parameterRef-typed args.
  {
    "object.value": {
      name: "PhaseArgs",
      children: [{ "field.int": { name: "caseId", "@required": true } }],
    },
  },
  {
    "object.projection": {
      name: "PhaseSummary",
      children: [
        { "source.rdb": { "@kind": "storedProc", "@proc": "fn_phase_summary", "@parameterRef": "PhaseArgs" } },
        { "field.long": { name: "phaseId" } },
        { "field.string": { name: "phaseName" } },
      ],
    },
  },
  // FR-015 table-function projection: same callable category.
  {
    "object.projection": {
      name: "PhaseListing",
      children: [
        { "source.rdb": { "@kind": "tableFunction", "@function": "fn_phase_listing", "@parameterRef": "PhaseArgs" } },
        { "field.long": { name: "id" } },
      ],
    },
  },
  // Materialized-view projection: hand-managed; must not emit plain-view DDL.
  {
    "object.projection": {
      name: "ProgramStats",
      children: [
        { "source.rdb": { "@kind": "materializedView", "@materializedView": "mv_program_stats" } },
        { "field.int": { name: "id", extends: "acme::Program.id" } },
        { "identity.primary": { name: "id", extends: "acme::Program.id" } },
      ],
    },
  },
];

describe("buildProjectionViews — non-plain-view projection kinds", () => {
  test("does not throw on proc/tableFunction projections, and manages ONLY the plain view", async () => {
    const root = await load(MODEL);
    // THE BUG: this call crashed outright ("cannot derive the base entity")
    // because the proc projection reached extractViewSpec.
    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(views.map((v) => v.name)).toEqual(["v_programs"]);
  });

  test("a matview projection emits NO plain-view DDL (hand-managed, not silently mis-created)", async () => {
    const root = await load(MODEL);
    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(views.some((v) => v.name === "mv_program_stats")).toBe(false);
  });

  test("an EXTENDS-anchored projection with no origins is still MANAGED (extends alone derives the view)", async () => {
    // Guard against over-eager skipping: ProgramView in MODEL carries extends-bound
    // fields and NO origin.* children, and it must keep producing managed DDL. A
    // discriminator keyed on origins alone would silently stop managing it — the view
    // would vanish from migrate's plan and `verify --db` would go blind to it.
    const root = await load(MODEL);
    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(views.map((v) => v.name)).toContain("v_programs");
  });
});

describe("buildProjectionViews — a STANDALONE read-model must not abort the whole run", () => {
  // A plain-view projection that declares its own columns and anchors nothing: no
  // extends, no origin.*. There is nothing to synthesize a view body FROM, so its SQL is
  // hand-authored — the documented custom-SQL-view exception, and a shape codegen already
  // supports on purpose (projection-decl.ts: "standalone views hand-author … their SQL").
  //
  // THE BUG: the schema path threw "cannot derive the base entity" on it, and because the
  // CLI calls buildProjectionViews unconditionally, ONE such view aborted `meta migrate`
  // for the ENTIRE model. An adopter with a couple of hand-written monitoring views could
  // not run migrate at all — for any entity.
  const STANDALONE = {
    "object.projection": {
      name: "SessionHealth",
      children: [
        { "source.rdb": { "@kind": "view", "@view": "v_session_health" } },
        { "field.long": { name: "sessionId" } },
        { "field.boolean": { name: "hasError" } },
      ],
    },
  };

  test("does NOT throw, and migrate still manages every other view in the model", async () => {
    const root = await load([...MODEL, STANDALONE]);
    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    // The whole model still migrates…
    expect(views.map((v) => v.name)).toEqual(["v_programs"]);
    // …and the hand-authored view is left alone: neither created nor dropped.
    expect(views.some((v) => v.name === "v_session_health")).toBe(false);
  });

  test("skipping cannot hide an authoring error: a malformed DERIVED projection is rejected at LOAD time", async () => {
    // This is what makes the skip above safe. origin.* says "this column comes from that
    // entity's column" — so the author clearly intended a DERIVED view and simply gave it
    // nothing to derive FROM. That is a mistake, not a standalone read-model, and it must
    // not be silently skipped.
    //
    // It isn't: the LOADER rejects it outright, so it never reaches the schema path. The
    // two cases are therefore cleanly separated — an unanchored projection that survives
    // the loader carries no origins, and is by construction a hand-authored read-model.
    const MALFORMED = {
      "object.projection": {
        name: "BrokenSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@view": "v_broken" } },
          {
            "field.string": {
              name: "title",
              children: [{ "origin.passthrough": { "@from": "acme::Program.title" } }],
            },
          },
        ],
      },
    };
    const json = JSON.stringify({ "metadata.root": { package: "acme", children: [...MODEL, MALFORMED] } });
    const { errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(errors.map(String).join("\n")).toMatch(/cannot derive the base entity/);
  });
});
