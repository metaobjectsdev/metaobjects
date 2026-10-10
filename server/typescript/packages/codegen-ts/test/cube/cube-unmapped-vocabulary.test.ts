// FR-044 Plan 4, Task 8a — the guard that refuses what cube-model does not map yet. `@spine` on
// a served object.report and `@default` on a measure.aggregate / measure.ratio are planned
// vocabulary (the zero-rows / measure-defaults plan). Until the build maps them, a model that
// carries either would be written WRONG without a word (a rollup without the spine's zero rows,
// a measure without its COALESCE), so the build refuses it, naming the node. What produces no
// output stays inert. The default loader is non-strict, so the attributes load with a warning.

import { describe, test, expect } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";
import { CUBE_ERROR_CODES, CubeModelError, ERR_CUBE_UNMAPPED_VOCABULARY } from "../../src/cube/cube-errors.js";
import type { CubeModel } from "../../src/cube/cube-model-spec.js";

type Json = Record<string, unknown>;

const PKG = "acme::shop";

const longId: Json = { "field.long": { name: "id" } };
const pk: Json = { "identity.primary": { name: "id", "@fields": "id" } };
const table = (name: string): Json => ({ "source.rdb": { "@table": name } });

function entity(name: string, children: Json[], extra: Json = {}): Json {
  return { "object.entity": { name, ...extra, children } };
}

/** Program: a table, a key, a count and a sum; `extra` children go last. */
function program(extra: Json[] = []): Json {
  return entity("Program", [
    table("programs"),
    longId,
    { "field.currency": { name: "priceCents", "@currency": "USD" } },
    pk,
    { "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } },
    { "measure.aggregate": { name: "listValue", "@agg": "sum", "@of": "Program.priceCents" } },
    ...extra,
  ]);
}

/** A report; `kind` names its one source's @kind; null: no source at all (sourceless, so inert). */
function report(name: string, attrs: Json, kind: string | null = "view"): Json {
  const children = kind === null ? [] : [{ "source.rdb": { "@kind": kind, [`@${kind}`]: `v_${name.toLowerCase()}` } }];
  return { "object.report": { name, ...attrs, children } };
}

const spineReport = (name: string, kind: string | null = "view"): Json =>
  report(name, { "@from": "Program", "@measures": ["programs"], "@spine": "Program.fkOwner" }, kind);

async function load(children: Json[]): Promise<MetaRoot> {
  const model = { "metadata.root": { package: PKG, children } };
  // Non-strict by default: an attribute no provider registers yet loads, with a warning.
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

async function build(children: Json[], matches?: (name: string) => boolean): Promise<CubeModel> {
  const root = await load(children);
  return buildCubeModel(root, {
    dialect: "postgres",
    columnNamingStrategy: "literal",
    ...(matches !== undefined ? { matches: (o) => matches(o.name) } : {}),
  });
}

async function refusal(children: Json[], matches?: (name: string) => boolean): Promise<CubeModelError> {
  try {
    await build(children, matches);
  } catch (e) {
    if (e instanceof CubeModelError) return e;
    throw e;
  }
  throw new Error("expected a CubeModelError, and the build succeeded");
}

describe("ERR_CUBE_UNMAPPED_VOCABULARY is one of the generator's own codes", () => {
  test("it is listed", () => {
    expect(ERR_CUBE_UNMAPPED_VOCABULARY).toBe("ERR_CUBE_UNMAPPED_VOCABULARY");
    expect(CUBE_ERROR_CODES).toContain(ERR_CUBE_UNMAPPED_VOCABULARY);
  });
});

describe("@spine on a served report is refused", () => {
  test("the error names the report and the attribute, and says how to proceed", async () => {
    const err = await refusal([program(), spineReport("ProgramsByOwner")]);
    expect(err.code).toBe(ERR_CUBE_UNMAPPED_VOCABULARY);
    expect(err.message).toBe(
      "ERR_CUBE_UNMAPPED_VOCABULARY: report 'acme::shop::ProgramsByOwner' declares @spine, which cube-model does not map yet " +
        "(it arrives with the zero-rows/measure-defaults build). Written without it, the rollup would lack the rows " +
        "the spine adds, so the export is refused rather than written wrong. Narrow the generator's filter to leave " +
        "'acme::shop::Program' out, or remove @spine from the report.",
    );
  });

  test("a sourceless @spine report is inert: no error, and nothing written for it", async () => {
    const model = await build([program(), spineReport("ProgramsByOwner", null)]);
    const cube = model.cubes.find((c) => c.name === "Program")!;
    expect(cube.preAggregations).toEqual([]);
    expect(cube.segments).toEqual([]);
  });

  test("a report with a view source but no @spine is unchanged", async () => {
    const model = await build([program(), report("ProgramTotals", { "@from": "Program", "@measures": ["programs"] })]);
    expect(model.cubes.find((c) => c.name === "Program")!.preAggregations.map((p) => p.name)).toEqual(["ProgramTotals"]);
  });

  test("a @spine report whose @from the generator's filter leaves out is inert", async () => {
    const other = entity("Other", [table("others"), longId, pk, { "measure.aggregate": { name: "others", "@agg": "count", "@of": "Other.id" } }]);
    const model = await build([program(), other, spineReport("ProgramsByOwner")], (n) => n === "Other");
    expect(model.cubes.map((c) => c.name)).toEqual(["Other"]);
  });
});

describe("@default on a measure of a cube is refused", () => {
  test("on a measure.aggregate (a default of 0 included)", async () => {
    const err = await refusal([
      program([{ "measure.aggregate": { name: "listed", "@agg": "sum", "@of": "Program.priceCents", "@default": 0 } }]),
    ]);
    expect(err.code).toBe(ERR_CUBE_UNMAPPED_VOCABULARY);
    expect(err.message).toBe(
      "ERR_CUBE_UNMAPPED_VOCABULARY: cube 'Program': measure.aggregate 'acme::shop::Program.listed' declares @default, which " +
        "cube-model does not map yet (it arrives with the zero-rows/measure-defaults build). Written without it, the " +
        "Cube measure would read null where the report view reads the default, so the export is refused rather than " +
        "written wrong. Narrow the generator's filter to leave 'acme::shop::Program' out, or remove @default from the measure.",
    );
  });

  test("on a measure.ratio", async () => {
    const err = await refusal([
      program([
        { "measure.ratio": { name: "pricePerProgram", "@numerator": "listValue", "@denominator": "programs", "@default": 0 } },
      ]),
    ]);
    expect(err.code).toBe(ERR_CUBE_UNMAPPED_VOCABULARY);
    expect(err.message).toContain("measure.ratio 'acme::shop::Program.pricePerProgram' declares @default");
  });

  test("on a measure the entity inherits from an abstract base", async () => {
    const base = entity(
      "Base",
      [longId, pk, { "measure.aggregate": { name: "rows", "@agg": "count", "@of": "Base.id", "@default": 0 } }],
      { abstract: true },
    );
    const child = entity("Child", [table("children")], { extends: "Base" });
    const err = await refusal([base, child]);
    expect(err.code).toBe(ERR_CUBE_UNMAPPED_VOCABULARY);
    expect(err.message).toContain("cube 'Child'");
    expect(err.message).toContain("measure.aggregate 'acme::shop::Base.rows' declares @default");
  });

  test("on a measure of an entity with no table: no cube, so no error", async () => {
    const loose = entity("Loose", [longId, pk, { "measure.aggregate": { name: "loose", "@agg": "sum", "@of": "Loose.id", "@default": 0 } }]);
    const model = await build([program(), loose]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Program"]);
  });

  test("on a measure of an entity the generator's filter leaves out: no error", async () => {
    const other = entity("Other", [
      table("others"),
      longId,
      pk,
      { "measure.aggregate": { name: "others", "@agg": "sum", "@of": "Other.id", "@default": 0 } },
    ]);
    const model = await build([program(), other], (n) => n === "Program");
    expect(model.cubes.map((c) => c.name)).toEqual(["Program"]);
  });

  test("on a measure of a cube that is only a join target: it writes no measures, so no error", async () => {
    const week = entity("Week", [
      table("weeks"),
      longId,
      { "field.long": { name: "programId", "@required": true } },
      pk,
      { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
      { "dimension.attribute": { name: "programTitle", "@of": "Program.priceCents", "@via": "Week.fkProgram" } },
    ]);
    const model = await build([program([{ "measure.aggregate": { name: "listed", "@agg": "sum", "@of": "Program.priceCents", "@default": 0 } }]), week], (n) => n === "Week");
    const joinTarget = model.cubes.find((c) => c.name === "Program")!;
    expect(joinTarget.measures).toEqual([]);
  });

  test("a measure without @default is unchanged", async () => {
    const model = await build([program()]);
    expect(model.cubes[0]!.measures.map((m) => m.name)).toEqual(["programs", "listValue"]);
  });
});
