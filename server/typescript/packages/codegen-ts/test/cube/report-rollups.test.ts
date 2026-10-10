// FR-044 Plan 4, Task 3 — what a served object.report contributes to its @from cube (contract
// Table F): a `rollup` pre-aggregation over the members it lists and, for its @filter, a scope
// segment `<report>Scope`. One test per Table F row, the reports that contribute nothing, the
// relative dates that suppress a rollup, and the names the report adds. Every model is loaded
// with the real loader; the canonical model's rollups are in build-cube-model.test.ts (Table H).

import { describe, test, expect } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";
import { CubeModelError } from "../../src/cube/cube-errors.js";
import type { CubeDialect, CubeModel, CubeSpec } from "../../src/cube/cube-model-spec.js";

type Json = Record<string, unknown>;

const PKG = "acme::shop";

function entity(name: string, children: Json[], extra: Json = {}): Json {
  return { "object.entity": { name, ...extra, children } };
}

const longId: Json = { "field.long": { name: "id" } };
const pk: Json = { "identity.primary": { name: "id", "@fields": "id" } };

/** Program: attribute and time dimensions, two measures and a segment. `extra` children go last. */
function program(extra: Json[] = []): Json {
  return entity("Program", [
    { "source.rdb": { "@table": "programs" } },
    longId,
    { "field.string": { name: "title" } },
    { "field.string": { name: "status" } },
    { "field.timestamp": { name: "createdAt", "@localTime": true } },
    { "field.date": { name: "publishedOn" } },
    { "field.currency": { name: "priceCents", "@currency": "USD" } },
    pk,
    { "dimension.attribute": { name: "status", "@of": "Program.status" } },
    { "dimension.time": { name: "createdAt", "@of": "Program.createdAt", "@grains": ["day", "week", "month"] } },
    { "dimension.time": { name: "publishedOn", "@of": "Program.publishedOn", "@grains": ["week", "month"] } },
    { "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } },
    { "measure.aggregate": { name: "listValue", "@agg": "sum", "@of": "Program.priceCents" } },
    { "segment.filter": { name: "published", "@filter": { status: "PUBLISHED" } } },
    ...extra,
  ]);
}

/** Week: holds a reference onto Program and reads its title through it. */
function week(extra: Json[] = []): Json {
  return entity("Week", [
    { "source.rdb": { "@table": "weeks" } },
    longId,
    { "field.long": { name: "programId", "@required": true } },
    pk,
    { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
    { "dimension.attribute": { name: "program", "@of": "Week.programId" } },
    { "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Week.fkProgram" } },
    { "measure.aggregate": { name: "weeks", "@agg": "count", "@of": "Week.id" } },
    ...extra,
  ]);
}

/** A report; `kind` names its one source's @kind (the kind-matching alias names it); null: no source. */
function report(name: string, attrs: Json, kind: string | null = "view", extra: Json = {}): Json {
  const children = kind === null ? [] : [{ "source.rdb": { "@kind": kind, [`@${kind}`]: `v_${name.toLowerCase()}` } }];
  return { "object.report": { name, ...extra, ...attrs, children } };
}

function rootOf(children: Json[], pkg = PKG): Json {
  return { "metadata.root": { package: pkg, children } };
}

async function loadRoots(...models: Json[]): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load(
    models.map((m) => new InMemoryStringSource(JSON.stringify(m))),
  );
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

interface BuildOptions {
  readonly dialect?: CubeDialect;
  readonly matches?: (name: string) => boolean;
}

function buildRoot(root: MetaRoot, opts: BuildOptions = {}): CubeModel {
  const matches = opts.matches;
  return buildCubeModel(root, {
    dialect: opts.dialect ?? "postgres",
    columnNamingStrategy: "literal",
    ...(matches !== undefined ? { matches: (o) => matches(o.name) } : {}),
  });
}

async function build(children: Json[], opts: BuildOptions = {}): Promise<CubeModel> {
  return buildRoot(await loadRoots(rootOf(children)), opts);
}

function cube(model: CubeModel, name: string): CubeSpec {
  const hit = model.cubes.find((c) => c.name === name);
  if (hit === undefined) throw new Error(`no cube ${name} in [${model.cubes.map((c) => c.name).join(", ")}]`);
  return hit;
}

async function programCube(...reports: Json[]): Promise<CubeSpec> {
  return cube(await build([program(), ...reports]), "Program");
}

function errorOf(fn: () => unknown): CubeModelError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CubeModelError) return e;
    throw e;
  }
  throw new Error("expected a CubeModelError");
}

// ---------------------------------------------------------------------------
// Table F — one row per report part
// ---------------------------------------------------------------------------

describe("Table F — a rollup per served report, on its @from cube", () => {
  test("attribute dimensions and measures, each in listed order", async () => {
    const c = await programCube(report("ProgramsByStatus", { "@from": "Program", "@dimensions": ["status"], "@measures": ["listValue", "programs"] }));
    expect(c.preAggregations).toEqual([
      { name: "ProgramsByStatus", type: "rollup", measures: ["listValue", "programs"], dimensions: ["status"], segments: [] },
    ]);
  });

  test("dimensions follow the report's order, not their declaration order on the entity", async () => {
    const c = cube(
      await build([
        // Declared: status, title (after program()'s own dimensions).
        program([{ "dimension.attribute": { name: "title", "@of": "Program.title" } }]),
        report("ByTitleAndStatus", { "@from": "Program", "@dimensions": ["title", "status"], "@measures": ["listValue", "programs"] }),
      ]),
      "Program",
    );
    expect(c.dimensions.map((d) => d.name)).toEqual(["id", "status", "createdAt", "publishedOn", "title"]);
    expect(c.preAggregations).toEqual([
      { name: "ByTitleAndStatus", type: "rollup", measures: ["listValue", "programs"], dimensions: ["title", "status"], segments: [] },
    ]);
  });

  test("a @via dimension is a member of the @from cube, listed the same way; a qualified measure item is the measure", async () => {
    const model = await build([
      program(),
      week(),
      report("WeeksByProgram", { "@from": "Week", "@dimensions": ["program", "programTitle"], "@measures": ["Week.weeks"] }),
    ]);
    expect(cube(model, "Week").preAggregations).toEqual([
      { name: "WeeksByProgram", type: "rollup", measures: ["weeks"], dimensions: ["program", "programTitle"], segments: [] },
    ]);
    // The rollup is the @from cube's: the cube the @via reaches gets none.
    expect(cube(model, "Program").preAggregations).toEqual([]);
  });

  test("one time dimension: the documented time_dimension + granularity form", async () => {
    const c = await programCube(
      report("ProgramsByMonth", { "@from": "Program", "@dimensions": ["createdAt:month", "status"], "@measures": ["programs", "listValue"] }),
    );
    expect(c.preAggregations).toEqual([
      {
        name: "ProgramsByMonth", type: "rollup", measures: ["programs", "listValue"], dimensions: ["status"], segments: [],
        timeDimension: "createdAt", granularity: "month",
      },
    ]);
    expect(Object.keys(c.preAggregations[0]!)).not.toContain("timeDimensions");
  });

  test("two time dimensions: the time_dimensions list, in listed order", async () => {
    const c = await programCube(
      report("ProgramActivity", { "@from": "Program", "@dimensions": ["publishedOn:week", "createdAt:day"], "@measures": ["programs"] }),
    );
    expect(c.preAggregations).toEqual([
      {
        name: "ProgramActivity", type: "rollup", measures: ["programs"], dimensions: [], segments: [],
        timeDimensions: [
          { dimension: "publishedOn", granularity: "week" },
          { dimension: "createdAt", granularity: "day" },
        ],
      },
    ]);
    expect(Object.keys(c.preAggregations[0]!).sort()).toEqual(["dimensions", "measures", "name", "segments", "timeDimensions", "type"]);
  });

  test("one time dimension at two grains: the list form, one entry per grain", async () => {
    const c = await programCube(
      report("ProgramGrains", { "@from": "Program", "@dimensions": ["createdAt:week", "createdAt:month"], "@measures": ["programs"] }),
    );
    expect(c.preAggregations[0]!.timeDimensions).toEqual([
      { dimension: "createdAt", granularity: "week" },
      { dimension: "createdAt", granularity: "month" },
    ]);
  });

  test("@segment: the segment is listed in segments", async () => {
    const c = await programCube(
      report("ProgramsByWeek", { "@from": "Program", "@dimensions": ["createdAt:week"], "@measures": ["programs"], "@segment": "published" }),
    );
    expect(c.preAggregations).toEqual([
      {
        name: "ProgramsByWeek", type: "rollup", measures: ["programs"], dimensions: [], segments: ["published"],
        timeDimension: "createdAt", granularity: "week",
      },
    ]);
    // A declared segment is used as it is: the report adds no segment for it.
    expect(c.segments.map((s) => s.name)).toEqual(["published"]);
  });

  test("@filter: a public scope segment <report>Scope with the filter's SQL, listed after @segment", async () => {
    const c = await programCube(
      report("IntroPrograms", {
        "@from": "Program", "@measures": ["programs"], "@segment": "published", "@filter": { title: { like: "Intro%" } },
      }),
    );
    expect(c.segments).toEqual([
      { name: "published", sql: `{CUBE}."status" = 'PUBLISHED'` },
      { name: "introProgramsScope", sql: `{CUBE}."title" LIKE 'Intro%'` },
    ]);
    expect(c.preAggregations).toEqual([
      { name: "IntroPrograms", type: "rollup", measures: ["programs"], dimensions: [], segments: ["published", "introProgramsScope"] },
    ]);
  });

  test("a @filter of several clauses is one scope segment, ANDed as the view's WHERE is", async () => {
    const c = await programCube(
      report("PricedDrafts", { "@from": "Program", "@measures": ["programs"], "@filter": { status: "DRAFT", priceCents: { gt: 0, lte: 500 } } }),
    );
    expect(c.segments[1]).toEqual({
      name: "pricedDraftsScope",
      sql: `({CUBE}."status" = 'DRAFT' AND {CUBE}."priceCents" > 0 AND {CUBE}."priceCents" <= 500)`,
    });
  });

  test("no dimensions: a rollup with measures only (the totals row)", async () => {
    const c = await programCube(report("ProgramTotals", { "@from": "Program", "@measures": ["programs", "listValue"] }));
    expect(c.preAggregations).toEqual([
      { name: "ProgramTotals", type: "rollup", measures: ["programs", "listValue"], dimensions: [], segments: [] },
    ]);
  });

  test("rollups and scope segments are in report order, after the declared segments", async () => {
    const c = await programCube(
      report("Second", { "@from": "Program", "@measures": ["programs"], "@filter": { status: "B" } }),
      report("First", { "@from": "Program", "@measures": ["listValue"], "@filter": { status: "A" } }),
    );
    expect(c.segments.map((s) => s.name)).toEqual(["published", "secondScope", "firstScope"]);
    expect(c.preAggregations.map((r) => r.name)).toEqual(["Second", "First"]);
  });

  test("MySQL quotes the scope segment's column with backticks", async () => {
    const model = await build([program(), report("Drafts", { "@from": "Program", "@measures": ["programs"], "@filter": { status: "DRAFT" } })], {
      dialect: "mysql",
    });
    expect(cube(model, "Program").segments[1]).toEqual({ name: "draftsScope", sql: "{CUBE}.`status` = 'DRAFT'" });
  });

  test("a scope segment's literal is escaped for Cube like any other", async () => {
    const c = await programCube(report("Braced", { "@from": "Program", "@measures": ["programs"], "@filter": { title: "a{b}c" } }));
    expect(c.segments[1]).toEqual({ name: "bracedScope", sql: `{CUBE}."title" = 'a\\{b\\}c'` });
  });
});

// ---------------------------------------------------------------------------
// Relative dates — a rollup would freeze "now" at its build
// ---------------------------------------------------------------------------

describe("Table F — no rollup where a relative date would be frozen", () => {
  const recentFilter = { createdAt: { gte: { now: "-P30D" } } };

  test("a relative @filter: the scope segment, the view's own SQL, and no rollup", async () => {
    const c = await programCube(report("RecentPrograms", { "@from": "Program", "@measures": ["programs"], "@filter": recentFilter }));
    expect(c.segments).toEqual([
      { name: "published", sql: `{CUBE}."status" = 'PUBLISHED'` },
      { name: "recentProgramsScope", sql: `{CUBE}."createdAt" >= ((now() AT TIME ZONE 'UTC') - INTERVAL 'P30D')` },
    ]);
    expect(c.preAggregations).toEqual([]);
  });

  test("a relative date inside an and/or group of the @filter: no rollup", async () => {
    const c = await programCube(
      report("RecentOrDraft", {
        "@from": "Program", "@measures": ["programs"],
        "@filter": { or: [{ status: "DRAFT" }, { createdAt: { gte: { now: "-P7D" } } }] },
      }),
    );
    expect(c.segments.map((s) => s.name)).toEqual(["published", "recentOrDraftScope"]);
    expect(c.preAggregations).toEqual([]);
  });

  test("a relative date in the report's @segment: no rollup, and nothing else added", async () => {
    const c = cube(
      await build([
        program([{ "segment.filter": { name: "recent", "@filter": recentFilter } }]),
        report("RecentBySegment", { "@from": "Program", "@measures": ["programs"], "@segment": "recent" }),
      ]),
      "Program",
    );
    expect(c.segments.map((s) => s.name)).toEqual(["published", "recent"]);
    expect(c.preAggregations).toEqual([]);
  });

  test("a relative condition on a listed measure (its @filter): no rollup", async () => {
    const c = cube(
      await build([
        program([{ "measure.aggregate": { name: "recentCount", "@agg": "count", "@of": "Program.id", "@filter": recentFilter } }]),
        report("RecentCounts", { "@from": "Program", "@dimensions": ["status"], "@measures": ["programs", "recentCount"] }),
      ]),
      "Program",
    );
    expect(c.preAggregations).toEqual([]);
    expect(c.segments.map((s) => s.name)).toEqual(["published"]);
  });

  test("a relative condition on a listed measure (its @segment): no rollup", async () => {
    const c = cube(
      await build([
        program([
          { "segment.filter": { name: "recent", "@filter": recentFilter } },
          { "measure.aggregate": { name: "recentCount", "@agg": "count", "@of": "Program.id", "@segment": "recent" } },
        ]),
        report("RecentCounts", { "@from": "Program", "@measures": ["recentCount"] }),
      ]),
      "Program",
    );
    expect(c.preAggregations).toEqual([]);
  });

  test("a relative condition on an operand of a listed ratio: no rollup", async () => {
    const c = cube(
      await build([
        program([
          { "measure.aggregate": { name: "recentCount", "@agg": "count", "@of": "Program.id", "@filter": recentFilter } },
          { "measure.ratio": { name: "recentShare", "@numerator": "recentCount", "@denominator": "programs" } },
        ]),
        report("RecentShare", { "@from": "Program", "@measures": ["recentShare"] }),
      ]),
      "Program",
    );
    expect(c.preAggregations).toEqual([]);
  });

  test("a relative condition on a measure the report does not list does not stop its rollup", async () => {
    const c = cube(
      await build([
        program([{ "measure.aggregate": { name: "recentCount", "@agg": "count", "@of": "Program.id", "@filter": recentFilter } }]),
        report("AllPrograms", { "@from": "Program", "@measures": ["programs"] }),
      ]),
      "Program",
    );
    expect(c.preAggregations.map((r) => r.name)).toEqual(["AllPrograms"]);
  });

  test("an absolute date is no reason to drop the rollup", async () => {
    const c = await programCube(
      report("Since2020", { "@from": "Program", "@measures": ["programs"], "@filter": { createdAt: { gte: "2020-01-01T00:00:00" } } }),
    );
    expect(c.preAggregations).toEqual([
      { name: "Since2020", type: "rollup", measures: ["programs"], dimensions: [], segments: ["since2020Scope"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reports that contribute nothing
// ---------------------------------------------------------------------------

describe("Table F — a report that is not served contributes nothing", () => {
  const attrs: Json = { "@from": "Program", "@dimensions": ["status"], "@measures": ["programs"], "@filter": { status: "DRAFT" } };

  test.each([
    ["a sourceless report", report("Unserved", attrs, null)],
    ["an abstract report", report("Unserved", attrs, "view", { abstract: true })],
    ["a materializedView report", report("Unserved", attrs, "materializedView")],
  ])("%s", async (_label, unserved) => {
    const withReport = await build([program(), unserved]);
    expect(withReport).toEqual(await build([program()]));
    expect(cube(withReport, "Program").preAggregations).toEqual([]);
    expect(cube(withReport, "Program").segments.map((s) => s.name)).toEqual(["published"]);
  });
});

// ---------------------------------------------------------------------------
// Selection — a report follows its @from cube
// ---------------------------------------------------------------------------

describe("selection — a report writes into its @from cube whenever that cube is emitted", () => {
  const byStatus = report("ByStatus", { "@from": "Program", "@dimensions": ["status"], "@measures": ["programs"], "@filter": { status: "LIVE" } });

  test("matches selects entities, not reports: a selection of the @from entity alone keeps its rollup", async () => {
    const all = await build([program(), byStatus]);
    const onlyProgram = await build([program(), byStatus], { matches: (name) => name === "Program" });
    expect(cube(onlyProgram, "Program")).toEqual(cube(all, "Program"));
    expect(cube(onlyProgram, "Program").preAggregations.map((r) => r.name)).toEqual(["ByStatus"]);
  });

  test("a @from entity that is not selected gets no rollup, also when another cube reaches it", async () => {
    const model = await build([program(), week(), byStatus], { matches: (name) => name === "Week" });
    // Program is only a join target here: its key and the member Week reads.
    const target = cube(model, "Program");
    expect(target.public).toBe(false);
    expect(target.preAggregations).toEqual([]);
    expect(target.segments).toEqual([]);
  });

  test("ERR_CUBE_UNMAPPABLE_REPORT: a served report whose @from has no table", async () => {
    const root = await loadRoots(
      rootOf([
        entity("Ghost", [
          longId,
          { "field.string": { name: "status" } },
          pk,
          { "measure.aggregate": { name: "ghosts", "@agg": "count", "@of": "Ghost.id" } },
        ]),
        report("GhostTotals", { "@from": "Ghost", "@measures": ["ghosts"] }),
      ]),
    );
    const err = errorOf(() => buildRoot(root));
    expect(err.code).toBe("ERR_CUBE_UNMAPPABLE_REPORT");
    expect(err.message).toStartWith(
      "ERR_CUBE_UNMAPPABLE_REPORT: report 'acme::shop::GhostTotals' is served, and its @from 'acme::shop::Ghost' " +
        "has no cube to hold its rollup: 'acme::shop::Ghost' declares no writable source.rdb",
    );
    // Narrowed away by the selection, it is not this run's to refuse.
    expect(buildRoot(root, { matches: (name) => name !== "Ghost" })).toEqual({ cubes: [], views: [] });
  });

  test("ERR_CUBE_UNMAPPABLE_REPORT: a served report whose @from is abstract", async () => {
    const root = await loadRoots(
      rootOf([
        entity(
          "Base",
          [
            { "source.rdb": { "@table": "bases" } },
            longId,
            pk,
            { "measure.aggregate": { name: "rows", "@agg": "count", "@of": "Base.id" } },
          ],
          { abstract: true },
        ),
        report("BaseTotals", { "@from": "Base", "@measures": ["rows"] }),
      ]),
    );
    const err = errorOf(() => buildRoot(root));
    expect(err.code).toBe("ERR_CUBE_UNMAPPABLE_REPORT");
    expect(err.message).toContain("report 'acme::shop::BaseTotals'");
    expect(err.message).toContain("'acme::shop::Base' is abstract");
  });

  test("a TPH subtype @from: the rollup is on the subtype's cube, which its discriminator scopes", async () => {
    const model = await build([
      entity(
        "Auth",
        [
          { "source.rdb": { "@table": "auths" } },
          longId,
          { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
          { "field.string": { name: "status" } },
          pk,
        ],
        { "@discriminator": "type" },
      ),
      entity(
        "BridgeAuth",
        [
          { "dimension.attribute": { name: "status", "@of": "BridgeAuth.status" } },
          { "measure.aggregate": { name: "bridges", "@agg": "count", "@of": "BridgeAuth.id" } },
        ],
        { extends: "Auth", "@discriminatorValue": "Bridge" },
      ),
      report("BridgesByStatus", { "@from": "BridgeAuth", "@dimensions": ["status"], "@measures": ["bridges"] }),
    ]);
    expect(model.cubes.map((c) => c.name)).toEqual(["BridgeAuth"]);
    const c = cube(model, "BridgeAuth");
    expect(c.sql).toBe(`SELECT * FROM "auths" WHERE "type" = 'Bridge'`);
    expect(c.preAggregations).toEqual([
      { name: "BridgesByStatus", type: "rollup", measures: ["bridges"], dimensions: ["status"], segments: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Table G — the names a report adds
// ---------------------------------------------------------------------------

describe("Table G — the names a report adds", () => {
  test("ERR_CUBE_MEMBER_COLLISION: a scope segment named like a declared segment, naming both", async () => {
    const root = await loadRoots(
      rootOf([
        program([{ "segment.filter": { name: "recentProgramsScope", "@filter": { status: "X" } } }]),
        report("RecentPrograms", { "@from": "Program", "@measures": ["programs"], "@filter": { status: "Y" } }),
      ]),
    );
    const err = errorOf(() => buildRoot(root));
    expect(err.code).toBe("ERR_CUBE_MEMBER_COLLISION");
    expect(err.message).toStartWith("ERR_CUBE_MEMBER_COLLISION: cube 'Program': ");
    expect(err.message).toContain("segment 'acme::shop::Program.recentProgramsScope'");
    expect(err.message).toContain(
      "the segment 'recentProgramsScope' the exporter adds for the @filter of report 'acme::shop::RecentPrograms'",
    );
  });

  test("ERR_CUBE_MEMBER_COLLISION: a rollup named like a member (Cube's pre-aggregations share the namespace)", async () => {
    const root = await loadRoots(
      rootOf([
        program([{ "measure.aggregate": { name: "Totals", "@agg": "count", "@of": "Program.id" } }]),
        report("Totals", { "@from": "Program", "@measures": ["programs"] }),
      ]),
    );
    const err = errorOf(() => buildRoot(root));
    expect(err.code).toBe("ERR_CUBE_MEMBER_COLLISION");
    expect(err.message).toContain("measure 'acme::shop::Program.Totals'");
    expect(err.message).toContain("the rollup 'Totals' of report 'acme::shop::Totals'");
    expect(err.message).toContain("pre-aggregations");
  });

  test("ERR_CUBE_MEMBER_COLLISION: two reports of one name in two packages on one @from cube", async () => {
    const root = await loadRoots(
      rootOf([program(), report("Totals", { "@from": "Program", "@measures": ["programs"] })]),
      rootOf([report("Totals", { "@from": "acme::shop::Program", "@measures": ["listValue"] })], "acme::other"),
    );
    const err = errorOf(() => buildRoot(root));
    expect(err.code).toBe("ERR_CUBE_MEMBER_COLLISION");
    expect(err.message).toContain("the rollup 'Totals' of report 'acme::shop::Totals'");
    expect(err.message).toContain("the rollup 'Totals' of report 'acme::other::Totals'");
  });

  test("ERR_CUBE_INVALID_NAME: a report named with a Python keyword cannot name a rollup", async () => {
    const root = await loadRoots(rootOf([program(), report("None", { "@from": "Program", "@measures": ["programs"] })]));
    const err = errorOf(() => buildRoot(root));
    expect(err.code).toBe("ERR_CUBE_INVALID_NAME");
    expect(err.message).toStartWith("ERR_CUBE_INVALID_NAME: the rollup 'None' of report 'acme::shop::None' is named 'None'");
  });
});
