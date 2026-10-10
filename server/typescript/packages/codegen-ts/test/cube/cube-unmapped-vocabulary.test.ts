// FR-044 Plan 4, Task 8a — the guard that refuses what cube-model does not map yet: `@spine` on a
// served object.report (the zero-rows / measure-defaults build, #415). Until it is mapped, a model
// that carries it would be written WRONG without a word (a rollup without the spine's zero rows),
// so the build refuses it, naming the report. What produces no output stays inert. Every model
// below loads clean under the loader's rules for the attribute (R8, R9).

import { describe, test, expect } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";
import { CubeModelError, ERR_CUBE_UNMAPPED_VOCABULARY } from "../../src/cube/cube-errors.js";
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

/** What a `@spine` report needs to load: a to-one hop from Program (R8) and a listed dimension
 *  read through it (R9). Passed to `program()`, with `owner` beside it. */
const ownerHop: Json[] = [
  { "field.long": { name: "ownerId" } },
  { "identity.reference": { name: "fkOwner", "@fields": "ownerId", "@references": "Owner" } },
  { "dimension.attribute": { name: "owner", "@of": "Owner.id", "@via": "Program.fkOwner" } },
];
const owner: Json = entity("Owner", [table("owners"), longId, pk]);

const spineReport = (name: string, kind: string | null = "view"): Json =>
  report(
    name,
    { "@from": "Program", "@dimensions": ["owner"], "@measures": ["programs"], "@spine": "Program.fkOwner" },
    kind,
  );

async function load(children: Json[]): Promise<MetaRoot> {
  const model = { "metadata.root": { package: PKG, children } };
  // The models load clean; what is under test is the build, not the loader.
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

describe("@spine on a served report is refused", () => {
  test("the error names the report and the attribute, and says how to proceed", async () => {
    const err = await refusal([program(ownerHop), owner, spineReport("ProgramsByOwner")]);
    expect(err.code).toBe(ERR_CUBE_UNMAPPED_VOCABULARY);
    expect(err.message).toBe(
      "ERR_CUBE_UNMAPPED_VOCABULARY: report 'acme::shop::ProgramsByOwner' declares @spine, which cube-model does not map yet. " +
        "Written without it, the rollup would lack the rows the spine adds, so the export is refused rather than " +
        "written wrong. Narrow the generator's filter to leave 'acme::shop::Program' out, or remove @spine from the report.",
    );
  });

  test("a sourceless @spine report is inert: no error, and nothing written for it", async () => {
    const model = await build([program(ownerHop), owner, spineReport("ProgramsByOwner", null)]);
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
    const model = await build([program(ownerHop), owner, other, spineReport("ProgramsByOwner")], (n) => n === "Other");
    expect(model.cubes.map((c) => c.name)).toEqual(["Other"]);
  });
});
