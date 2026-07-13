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
});
