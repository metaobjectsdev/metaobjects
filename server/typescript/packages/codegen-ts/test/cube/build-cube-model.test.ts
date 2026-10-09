// FR-044 Plan 4, Task 2 — buildCubeModel, the pure stage of the cube-model reference
// generator. One test per row of the plan's Tables A, C, D and E, the Table G errors this
// stage raises, and the canonical model against Table H's data (rollups and the report scope
// segment are Task 3's). Every model is loaded with the real loader.

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryStringSource, MetaDataLoader, loadUris, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";
import { CubeModelError } from "../../src/cube/cube-errors.js";
import type { CubeDialect, CubeModel, CubeSpec } from "../../src/cube/cube-model-spec.js";

type Json = Record<string, unknown>;

const PKG = "acme::shop";

function entity(name: string, children: Json[], extra: Json = {}): Json {
  return { "object.entity": { name, ...extra, children } };
}

function table(name: string, extra: Json = {}): Json {
  return { "source.rdb": { "@table": name, ...extra } };
}

const longId: Json = { "field.long": { name: "id" } };
const pk: Json = { "identity.primary": { name: "id", "@fields": "id" } };

/** Program: a table, a key and a title. `extra` children go last. */
function program(extra: Json[] = []): Json {
  return entity("Program", [table("programs"), longId, { "field.string": { name: "title" } }, pk, ...extra]);
}

/** Week: holds a reference onto Program. */
function week(extra: Json[] = []): Json {
  return entity("Week", [
    table("weeks"),
    longId,
    { "field.long": { name: "programId", "@required": true } },
    { "field.int": { name: "durationMinutes" } },
    pk,
    { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
    ...extra,
  ]);
}

const weeksCount: Json = { "measure.aggregate": { name: "weeks", "@agg": "count", "@of": "Week.id" } };

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

async function build(
  children: Json[],
  opts: { dialect?: CubeDialect; strategy?: "literal" | "snake_case"; matches?: (name: string) => boolean } = {},
): Promise<CubeModel> {
  const root = await loadRoots(rootOf(children));
  const matches = opts.matches;
  return buildCubeModel(root, {
    dialect: opts.dialect ?? "postgres",
    columnNamingStrategy: opts.strategy ?? "literal",
    ...(matches !== undefined ? { matches: (o) => matches(o.name) } : {}),
  });
}

function cube(model: CubeModel, name: string): CubeSpec {
  const hit = model.cubes.find((c) => c.name === name);
  if (hit === undefined) throw new Error(`no cube ${name} in [${model.cubes.map((c) => c.name).join(", ")}]`);
  return hit;
}

async function buildError(children: Json[], opts: { dialect?: CubeDialect } = {}): Promise<CubeModelError> {
  try {
    await build(children, opts);
  } catch (e) {
    if (e instanceof CubeModelError) return e;
    throw e;
  }
  throw new Error("expected a CubeModelError");
}

// ---------------------------------------------------------------------------
// Table A — what becomes a cube
// ---------------------------------------------------------------------------

describe("Table A — what becomes a cube", () => {
  test("a model with no reporting vocabulary has no cube", async () => {
    const model = await build([program(), week()]);
    expect(model).toEqual({ cubes: [], views: [] });
  });

  test("a concrete entity with a table and a member is one cube over its table", async () => {
    const model = await build([program([{ "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } }])]);
    expect(model.cubes).toEqual([
      {
        name: "Program",
        sqlTable: '"programs"',
        joins: [],
        dimensions: [{ name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true }],
        measures: [{ name: "programs", sql: '{CUBE}."id"', type: "count" }],
        segments: [],
        preAggregations: [],
      },
    ]);
    expect(model.views).toEqual([]);
  });

  test("@schema qualifies sql_table", async () => {
    const model = await build([
      entity("Program", [
        table("programs", { "@schema": "sales" }),
        longId,
        pk,
        { "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } },
      ]),
    ]);
    expect(cube(model, "Program").sqlTable).toBe('"sales"."programs"');
  });

  test("an abstract base's members land on each concrete entity, and the base has no cube", async () => {
    const model = await build([
      entity(
        "Base",
        [
          longId,
          { "field.string": { name: "status" } },
          pk,
          { "dimension.attribute": { name: "status", "@of": "Base.status" } },
          { "measure.aggregate": { name: "rows", "@agg": "count", "@of": "Base.id" } },
          { "segment.filter": { name: "open", "@filter": { status: "OPEN" } } },
        ],
        { abstract: true },
      ),
      entity("Ticket", [table("tickets")], { extends: "Base" }),
      entity("Order", [table("orders")], { extends: "Base" }),
    ]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Ticket", "Order"]);
    for (const [name, tbl] of [["Ticket", '"tickets"'], ["Order", '"orders"']] as const) {
      const c = cube(model, name);
      expect(c.sqlTable).toBe(tbl);
      expect(c.dimensions).toEqual([
        { name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true },
        { name: "status", sql: '{CUBE}."status"', type: "string" },
      ]);
      expect(c.measures).toEqual([{ name: "rows", sql: '{CUBE}."id"', type: "count" }]);
      expect(c.segments).toEqual([{ name: "open", sql: `{CUBE}."status" = 'OPEN'` }]);
    }
  });

  test("an entity with members and no table has no cube (inert)", async () => {
    const model = await build([
      entity("Loose", [longId, pk, { "measure.aggregate": { name: "n", "@agg": "count", "@of": "Loose.id" } }]),
    ]);
    expect(model.cubes).toEqual([]);
  });

  test("a TPH subtype's cube selects the base table with its discriminator predicate", async () => {
    const model = await build([
      entity(
        "Auth",
        [
          table("auths"),
          longId,
          { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
          pk,
        ],
        { "@discriminator": "type" },
      ),
      entity(
        "BridgeAuth",
        [{ "measure.aggregate": { name: "bridges", "@agg": "count", "@of": "BridgeAuth.id" } }],
        { extends: "Auth", "@discriminatorValue": "Bridge" },
      ),
    ]);
    expect(model.cubes.map((c) => c.name)).toEqual(["BridgeAuth"]);
    const c = cube(model, "BridgeAuth");
    expect(c.sqlTable).toBeUndefined();
    expect(c.sql).toBe(`SELECT * FROM "auths" WHERE "type" = 'Bridge'`);
    expect(c.measures).toEqual([{ name: "bridges", sql: '{CUBE}."id"', type: "count" }]);
  });

  test("matches selects the cubes; a cube a matched cube reaches is emitted anyway", async () => {
    const children = [
      program([{ "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } }]),
      week([
        weeksCount,
        { "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Week.fkProgram" } },
      ]),
    ];
    const onlyProgram = await build(children, { matches: (n) => n === "Program" });
    expect(onlyProgram.cubes.map((c) => c.name)).toEqual(["Program"]);
    expect(cube(onlyProgram, "Program").measures.map((m) => m.name)).toEqual(["programs"]);

    // Week is matched and reaches Program, which is not: Program is a join-target cube with
    // only its key and the reached member, not its own measures.
    const onlyWeek = await build(children, { matches: (n) => n === "Week" });
    expect(onlyWeek.cubes.map((c) => c.name)).toEqual(["Program", "Week"]);
    expect(cube(onlyWeek, "Program")).toEqual({
      name: "Program",
      sqlTable: '"programs"',
      public: false,
      joins: [],
      dimensions: [
        { name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true },
        { name: "title", sql: '{CUBE}."title"', type: "string", public: false },
      ],
      measures: [],
      segments: [],
      preAggregations: [],
    });
  });

  test("title and description are copied onto the cube and its declared members; notes never are", async () => {
    const model = await build([
      entity(
        "Program",
        [
          table("programs"),
          longId,
          { "field.string": { name: "title" } },
          pk,
          {
            "dimension.attribute": {
              name: "titleDim", "@of": "Program.title", "@title": "Title", "@description": "The title.", "@notes": "internal",
            },
          },
          { "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id", "@title": "Programs" } },
          { "segment.filter": { name: "named", "@filter": { title: { ne: "" } }, "@description": "Has a title." } },
        ],
        { "@title": "Programs", "@description": "Every program.", "@notes": "internal" },
      ),
    ]);
    const c = cube(model, "Program");
    expect(c.title).toBe("Programs");
    expect(c.description).toBe("Every program.");
    expect(c.dimensions[1]).toEqual({
      name: "titleDim", sql: '{CUBE}."title"', type: "string", title: "Title", description: "The title.",
    });
    expect(c.measures[0]).toEqual({ name: "programs", sql: '{CUBE}."id"', type: "count", title: "Programs" });
    expect(c.segments[0]).toEqual({ name: "named", sql: `{CUBE}."title" <> ''`, description: "Has a title." });
    expect(JSON.stringify(model)).not.toContain("internal");
  });
});

// ---------------------------------------------------------------------------
// Table C — dimension types
// ---------------------------------------------------------------------------

describe("Table C — dimension types", () => {
  async function dimensionOf(field: Json, dimension: Json = {}, dialect: CubeDialect = "postgres") {
    const name = (Object.values(field)[0] as { name: string }).name;
    const model = await build(
      [
        entity("Thing", [
          table("things"),
          longId,
          field,
          pk,
          { "dimension.attribute": { name: "d", "@of": `Thing.${name}`, ...dimension } },
        ]),
      ],
      { dialect },
    );
    return cube(model, "Thing").dimensions.find((x) => x.name === "d");
  }

  test.each([
    ["string", { "field.string": { name: "x" } }],
    ["enum (string-backed)", { "field.enum": { name: "x", "@values": ["A", "B"] } }],
    ["uuid", { "field.uuid": { name: "x" } }],
    ["time", { "field.time": { name: "x" } }],
  ])("%s → string, the column", async (_label, field) => {
    expect(await dimensionOf(field)).toEqual({ name: "d", sql: '{CUBE}."x"', type: "string" });
  });

  test("enum with @intValueMap → string, a CASE that carries the member symbol", async () => {
    expect(
      await dimensionOf({ "field.enum": { name: "x", "@values": ["A", "B"], "@intValueMap": { A: 1, B: 2 } } }),
    ).toEqual({ name: "d", sql: `CASE {CUBE}."x" WHEN 1 THEN 'A' WHEN 2 THEN 'B' END`, type: "string" });
  });

  test.each([
    ["int", { "field.int": { name: "x" } }],
    ["long", { "field.long": { name: "x" } }],
    ["double", { "field.double": { name: "x" } }],
    ["float", { "field.float": { name: "x" } }],
    ["decimal", { "field.decimal": { name: "x", "@precision": 10, "@scale": 2 } }],
    ["currency", { "field.currency": { name: "x", "@currency": "USD" } }],
  ])("%s → number, the column", async (_label, field) => {
    expect(await dimensionOf(field)).toEqual({ name: "d", sql: '{CUBE}."x"', type: "number" });
  });

  test("boolean → boolean, the column", async () => {
    expect(await dimensionOf({ "field.boolean": { name: "x" } })).toEqual({
      name: "d", sql: '{CUBE}."x"', type: "boolean",
    });
  });

  test("date → time, cast to TIMESTAMP (attribute dimension)", async () => {
    expect(await dimensionOf({ "field.date": { name: "x" } })).toEqual({
      name: "d", sql: 'CAST({CUBE}."x" AS TIMESTAMP)', type: "time",
    });
  });

  test("date on MySQL casts to DATETIME (MySQL's CAST has no TIMESTAMP target)", async () => {
    expect(await dimensionOf({ "field.date": { name: "x" } }, {}, "mysql")).toEqual({
      name: "d", sql: "CAST({CUBE}.`x` AS DATETIME)", type: "time",
    });
  });

  test.each([
    ["timestamp", { "field.timestamp": { name: "x" } }],
    ["timestamp @localTime", { "field.timestamp": { name: "x", "@localTime": true } }],
  ])("%s → time, the column", async (_label, field) => {
    expect(await dimensionOf(field)).toEqual({ name: "d", sql: '{CUBE}."x"', type: "time" });
  });

  test("a time dimension carries @grains as meta.grains, and a date one is cast", async () => {
    const model = await build([
      entity("Thing", [
        table("things"),
        longId,
        { "field.date": { name: "on" } },
        { "field.timestamp": { name: "at", "@column": "at_ts" } },
        pk,
        { "dimension.time": { name: "onDay", "@of": "Thing.on", "@grains": ["week", "month"] } },
        { "dimension.time": { name: "at", "@of": "Thing.at", "@grains": ["hour", "day"] } },
      ]),
    ]);
    expect(cube(model, "Thing").dimensions.slice(1)).toEqual([
      { name: "onDay", sql: 'CAST({CUBE}."on" AS TIMESTAMP)', type: "time", meta: { grains: ["week", "month"] } },
      { name: "at", sql: '{CUBE}."at_ts"', type: "time", meta: { grains: ["hour", "day"] } },
    ]);
  });

  test("the column honours the naming strategy and @column", async () => {
    const model = await build(
      [
        entity("Thing", [
          table("things"),
          longId,
          { "field.string": { name: "displayName" } },
          { "field.string": { name: "code", "@column": "CODE_X" } },
          pk,
          { "dimension.attribute": { name: "displayName", "@of": "Thing.displayName" } },
          { "dimension.attribute": { name: "code", "@of": "Thing.code" } },
        ]),
      ],
      { strategy: "snake_case" },
    );
    expect(cube(model, "Thing").dimensions.slice(1).map((d) => d.sql)).toEqual([
      '{CUBE}."display_name"',
      '{CUBE}."CODE_X"',
    ]);
  });

  test.each([
    ["isArray", { "field.string": { name: "x", isArray: true } }, /field\.string, isArray/],
    ["object", { "field.object": { name: "x", "@objectRef": "Label" } }, /field\.object/],
    ["map", { "field.map": { name: "x", "@valueType": "string" } }, /field\.map/],
  ])("%s → ERR_CUBE_UNMAPPABLE_DIMENSION naming the dimension and its field", async (_label, field, detail) => {
    const err = await buildError([
      { "object.value": { name: "Label", children: [{ "field.string": { name: "text" } }] } },
      entity("Thing", [table("things"), longId, field, pk, { "dimension.attribute": { name: "d", "@of": "Thing.x" } }]),
    ]);
    expect(err.code).toBe("ERR_CUBE_UNMAPPABLE_DIMENSION");
    expect(err.message).toStartWith("ERR_CUBE_UNMAPPABLE_DIMENSION: ");
    expect(err.message).toContain("dimension 'acme::shop::Thing.d'");
    expect(err.message).toContain("field 'acme::shop::Thing.x'");
    expect(err.message).toMatch(detail);
    expect(err.message).toContain("Cube has no array or JSON dimension type");
  });

  test("a subtype Table C does not list is refused, not guessed (field.uri)", async () => {
    const err = await buildError([
      entity("Thing", [
        table("things"), longId, { "field.uri": { name: "x" } }, pk,
        { "dimension.attribute": { name: "d", "@of": "Thing.x" } },
      ]),
    ]);
    expect(err.code).toBe("ERR_CUBE_UNMAPPABLE_DIMENSION");
    expect(err.message).toContain("field.uri");
  });
});

// ---------------------------------------------------------------------------
// Table D — measures
// ---------------------------------------------------------------------------

describe("Table D — measures", () => {
  async function weekMeasures(measures: Json[], dialect: CubeDialect = "postgres") {
    const model = await build(
      [
        program(),
        week([
          { "field.string": { name: "label" } },
          { "segment.filter": { name: "long", "@filter": { durationMinutes: { gte: 60 } } } },
          ...measures,
        ]),
      ],
      { dialect },
    );
    return cube(model, "Week").measures;
  }

  test("count → count over the column", async () => {
    expect(await weekMeasures([weeksCount])).toEqual([{ name: "weeks", sql: '{CUBE}."id"', type: "count" }]);
  });

  test("count + @distinct → count_distinct", async () => {
    expect(
      await weekMeasures([{ "measure.aggregate": { name: "labels", "@agg": "count", "@distinct": true, "@of": "Week.label" } }]),
    ).toEqual([{ name: "labels", sql: '{CUBE}."label"', type: "count_distinct" }]);
  });

  const tuple: Json = {
    "measure.aggregate": {
      name: "slots", "@agg": "count", "@distinct": true, "@of": ["Week.programId", "Week.durationMinutes"],
    },
  };

  test("a distinct tuple → count_distinct over ROW(...) plus a not-null filter (Postgres)", async () => {
    expect(await weekMeasures([tuple])).toEqual([
      {
        name: "slots",
        sql: 'ROW({CUBE}."programId", {CUBE}."durationMinutes")',
        type: "count_distinct",
        filters: [{ sql: '{CUBE}."programId" IS NOT NULL AND {CUBE}."durationMinutes" IS NOT NULL' }],
      },
    ]);
  });

  test("a distinct tuple on MySQL → JSON_ARRAY(...) with the same filter", async () => {
    expect(await weekMeasures([tuple], "mysql")).toEqual([
      {
        name: "slots",
        sql: "JSON_ARRAY({CUBE}.`programId`, {CUBE}.`durationMinutes`)",
        type: "count_distinct",
        filters: [{ sql: "{CUBE}.`programId` IS NOT NULL AND {CUBE}.`durationMinutes` IS NOT NULL" }],
      },
    ]);
  });

  test("a distinct tuple with a condition ANDs it after the not-null terms", async () => {
    const measures = await weekMeasures([
      { "measure.aggregate": { ...(tuple["measure.aggregate"] as Json), "@segment": "long" } },
    ]);
    expect(measures[0]!.filters).toEqual([
      {
        sql:
          '{CUBE}."programId" IS NOT NULL AND {CUBE}."durationMinutes" IS NOT NULL AND {CUBE}."durationMinutes" >= 60',
      },
    ]);
  });

  test.each(["sum", "avg", "min", "max"] as const)("%s → %s over the column", async (agg) => {
    expect(
      await weekMeasures([{ "measure.aggregate": { name: "m", "@agg": agg, "@of": "Week.durationMinutes" } }]),
    ).toEqual([{ name: "m", sql: '{CUBE}."durationMinutes"', type: agg }]);
  });

  test("@segment and @filter become one filters entry, ANDed by the lowering's own andOf", async () => {
    expect(
      await weekMeasures([
        {
          "measure.aggregate": {
            name: "longFirst", "@agg": "count", "@of": "Week.id", "@segment": "long", "@filter": { programId: 1 },
          },
        },
        { "measure.aggregate": { name: "longOnly", "@agg": "count", "@of": "Week.id", "@segment": "long" } },
      ]),
    ).toEqual([
      {
        name: "longFirst",
        sql: '{CUBE}."id"',
        type: "count",
        filters: [{ sql: '({CUBE}."durationMinutes" >= 60 AND {CUBE}."programId" = 1)' }],
      },
      { name: "longOnly", sql: '{CUBE}."id"', type: "count", filters: [{ sql: '{CUBE}."durationMinutes" >= 60' }] },
    ]);
  });

  test("a relative date in a measure filter is the view's own SQL", async () => {
    const model = await build([
      entity("Thing", [
        table("things"),
        longId,
        { "field.timestamp": { name: "at", "@localTime": true } },
        pk,
        { "measure.aggregate": { name: "recent", "@agg": "count", "@of": "Thing.id", "@filter": { at: { gte: { now: "-P7D" } } } } },
      ]),
    ]);
    expect(cube(model, "Thing").measures[0]!.filters).toEqual([
      { sql: `{CUBE}."at" >= ((now() AT TIME ZONE 'UTC') - INTERVAL 'P7D')` },
    ]);
  });

  const ratio: Json[] = [
    weeksCount,
    { "measure.aggregate": { name: "longWeeks", "@agg": "count", "@of": "Week.id", "@segment": "long" } },
    { "measure.ratio": { name: "longShare", "@numerator": "longWeeks", "@denominator": "weeks" } },
  ];

  test("measure.ratio → number over member references (Postgres casts to NUMERIC)", async () => {
    expect((await weekMeasures(ratio))[2]).toEqual({
      name: "longShare", sql: "CAST({longWeeks} AS NUMERIC) / NULLIF({weeks}, 0)", type: "number",
    });
  });

  test("measure.ratio on MySQL divides without a cast", async () => {
    expect((await weekMeasures(ratio, "mysql"))[2]).toEqual({
      name: "longShare", sql: "{longWeeks} / NULLIF({weeks}, 0)", type: "number",
    });
  });
});

// ---------------------------------------------------------------------------
// Table E — joins, reached members, join-target and alias cubes
// ---------------------------------------------------------------------------

describe("Table E — joins and reached members", () => {
  const programTitle: Json = {
    "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Week.fkProgram" },
  };

  test("a reference the cube holds onto a cube is a many_to_one join", async () => {
    const model = await build([
      program([{ "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } }]),
      week([weeksCount]),
    ]);
    expect(cube(model, "Week").joins).toEqual([
      { name: "Program", relationship: "many_to_one", sql: '{CUBE}."programId" = {Program}."id"' },
    ]);
    // Program holds no reference, and a to-many relationship is no join.
    expect(cube(model, "Program").joins).toEqual([]);
  });

  test("MySQL quotes the table and the join columns with backticks", async () => {
    const model = await build(
      [
        program([{ "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } }]),
        week([weeksCount]),
      ],
      { dialect: "mysql" },
    );
    expect(cube(model, "Week").sqlTable).toBe("`weeks`");
    expect(cube(model, "Week").joins).toEqual([
      { name: "Program", relationship: "many_to_one", sql: "{CUBE}.`programId` = {Program}.`id`" },
    ]);
  });

  test("a join is emitted between cubes only", async () => {
    // Program has no vocabulary and no dimension reaches it, so it is no cube and no join.
    const model = await build([program(), week([weeksCount])]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Week"]);
    expect(cube(model, "Week").joins).toEqual([]);
  });

  test("a to-one relationship whose reference the target holds is a one_to_one join", async () => {
    const model = await build([
      program([
        { "relationship.association": { name: "profile", "@objectRef": "Profile", "@cardinality": "one" } },
        { "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } },
      ]),
      entity("Profile", [
        table("profiles"),
        longId,
        { "field.long": { name: "programId" } },
        { "field.string": { name: "bio" } },
        pk,
        { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
        { "measure.aggregate": { name: "profiles", "@agg": "count", "@of": "Profile.id" } },
      ]),
    ]);
    expect(cube(model, "Program").joins).toEqual([
      { name: "Profile", relationship: "one_to_one", sql: '{CUBE}."id" = {Profile}."programId"' },
    ]);
    expect(cube(model, "Profile").joins).toEqual([
      { name: "Program", relationship: "many_to_one", sql: '{CUBE}."programId" = {Program}."id"' },
    ]);
  });

  test("a @via dimension reads {Program.title}, and title is added to Program once for two dimensions", async () => {
    const model = await build([
      program([{ "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } }]),
      week([
        programTitle,
        { "dimension.attribute": { name: "programName", "@of": "Program.title", "@via": "Week.fkProgram" } },
      ]),
    ]);
    expect(cube(model, "Week").dimensions.slice(1)).toEqual([
      { name: "programTitle", sql: "{Program.title}", type: "string" },
      { name: "programName", sql: "{Program.title}", type: "string" },
    ]);
    expect(cube(model, "Program").dimensions).toEqual([
      { name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true },
      { name: "title", sql: '{CUBE}."title"', type: "string", public: false },
    ]);
  });

  test("a declared Program dimension over title is reused instead of adding one", async () => {
    const model = await build([
      program([{ "dimension.attribute": { name: "name", "@of": "Program.title" } }]),
      week([programTitle]),
    ]);
    expect(cube(model, "Week").dimensions[1]).toEqual({ name: "programTitle", sql: "{Program.name}", type: "string" });
    expect(cube(model, "Program").dimensions.map((d) => d.name)).toEqual(["id", "name"]);
  });

  test("a @via onto the target's key field reads the key dimension", async () => {
    const model = await build([
      program(),
      week([{ "dimension.attribute": { name: "programKey", "@of": "Program.id", "@via": "Week.fkProgram" } }]),
    ]);
    expect(cube(model, "Week").dimensions[1]).toEqual({ name: "programKey", sql: "{Program.id}", type: "number" });
    expect(cube(model, "Program").dimensions).toEqual([
      { name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true },
    ]);
  });

  test("a @via onto an entity that is not a cube makes a join-target cube", async () => {
    const model = await build([program(), week([programTitle])]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Program", "Week"]);
    expect(cube(model, "Program").public).toBe(false);
    expect(cube(model, "Week").joins).toEqual([
      { name: "Program", relationship: "many_to_one", sql: '{CUBE}."programId" = {Program}."id"' },
    ]);
  });

  test("a multi-hop @via joins on each hop's holder and reads the far cube's member", async () => {
    const model = await build([
      entity("Org", [table("orgs"), longId, { "field.string": { name: "name" } }, pk]),
      program([
        { "field.long": { name: "orgId" } },
        { "identity.reference": { name: "fkOrg", "@fields": "orgId", "@references": "Org" } },
      ]),
      week([{ "dimension.attribute": { name: "orgName", "@of": "Org.name", "@via": "Week.fkProgram.fkOrg" } }]),
    ]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Org", "Program", "Week"]);
    expect(cube(model, "Week").dimensions[1]).toEqual({ name: "orgName", sql: "{Org.name}", type: "string" });
    expect(cube(model, "Week").joins).toEqual([
      { name: "Program", relationship: "many_to_one", sql: '{CUBE}."programId" = {Program}."id"' },
    ]);
    expect(cube(model, "Program").joins).toEqual([
      { name: "Org", relationship: "many_to_one", sql: '{CUBE}."orgId" = {Org}."id"' },
    ]);
    expect(cube(model, "Program").dimensions.map((d) => d.name)).toEqual(["id"]);
    expect(cube(model, "Org").dimensions).toEqual([
      { name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true },
      { name: "name", sql: '{CUBE}."name"', type: "string", public: false },
    ]);
  });

  test("two references onto one entity give two alias cubes, and the joins and dimensions use them", async () => {
    const model = await build([
      entity("Team", [table("teams"), longId, { "field.string": { name: "name" } }, pk]),
      entity("Match", [
        table("matches"),
        longId,
        { "field.long": { name: "homeTeamId" } },
        { "field.long": { name: "awayTeamId" } },
        pk,
        { "identity.reference": { name: "homeRef", "@fields": "homeTeamId", "@references": "Team" } },
        { "identity.reference": { name: "awayRef", "@fields": "awayTeamId", "@references": "Team" } },
        { "dimension.attribute": { name: "homeName", "@of": "Team.name", "@via": "Match.homeRef" } },
        { "dimension.attribute": { name: "awayName", "@of": "Team.name", "@via": "Match.awayRef" } },
      ]),
    ]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Team", "Match", "Match_homeRef", "Match_awayRef"]);
    expect(cube(model, "Match").joins).toEqual([
      { name: "Match_homeRef", relationship: "many_to_one", sql: '{CUBE}."homeTeamId" = {Match_homeRef}."id"' },
      { name: "Match_awayRef", relationship: "many_to_one", sql: '{CUBE}."awayTeamId" = {Match_awayRef}."id"' },
    ]);
    expect(cube(model, "Match").dimensions.slice(1)).toEqual([
      { name: "homeName", sql: "{Match_homeRef.name}", type: "string" },
      { name: "awayName", sql: "{Match_awayRef.name}", type: "string" },
    ]);
    for (const alias of ["Match_homeRef", "Match_awayRef"]) {
      expect(cube(model, alias)).toEqual({
        name: alias, extends: "Team", public: false,
        joins: [], dimensions: [], measures: [], segments: [], preAggregations: [],
      });
    }
    // The reached member is added once, on the cube the aliases extend.
    expect(cube(model, "Team").dimensions.map((d) => d.name)).toEqual(["id", "name"]);
  });

  test("a relationship backed by a reference the cube holds is that reference's join, not a second hop", async () => {
    const model = await build([
      program(),
      week([
        { "relationship.association": { name: "program", "@objectRef": "Program", "@cardinality": "one" } },
        { "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Week.program" } },
      ]),
    ]);
    expect(cube(model, "Week").joins).toEqual([
      { name: "Program", relationship: "many_to_one", sql: '{CUBE}."programId" = {Program}."id"' },
    ]);
    expect(cube(model, "Week").dimensions[1]!.sql).toBe("{Program.title}");
  });

  test("ERR_CUBE_AMBIGUOUS_PATH: a multi-hop @via whose far cube the graph reaches by two paths", async () => {
    const err = await buildError([
      entity("Org", [table("orgs"), longId, { "field.string": { name: "name" } }, pk]),
      program([
        { "field.long": { name: "orgId" } },
        { "identity.reference": { name: "fkOrg", "@fields": "orgId", "@references": "Org" } },
      ]),
      week([
        { "field.long": { name: "orgId" } },
        { "identity.reference": { name: "fkOrg", "@fields": "orgId", "@references": "Org" } },
        { "dimension.attribute": { name: "orgName", "@of": "Org.name", "@via": "Week.fkProgram.fkOrg" } },
      ]),
    ]);
    expect(err.code).toBe("ERR_CUBE_AMBIGUOUS_PATH");
    expect(err.message).toStartWith("ERR_CUBE_AMBIGUOUS_PATH: ");
    expect(err.message).toContain("dimension 'acme::shop::Week.orgName'");
    expect(err.message).toContain("(Week -> Program -> Org; Week -> Org)");
  });

  test("ERR_CUBE_NO_PRIMARY_KEY: a cube in a join with no identity.primary", async () => {
    const err = await buildError([
      entity("Program", [table("programs"), longId, { "field.string": { name: "title" } }]),
      week([programTitle]),
    ]);
    expect(err.code).toBe("ERR_CUBE_NO_PRIMARY_KEY");
    expect(err.message).toStartWith("ERR_CUBE_NO_PRIMARY_KEY: ");
    expect(err.message).toContain("'acme::shop::Program'");
    expect(err.message).toContain("identity.primary");
  });

  test("a self-reference is no join, and a @via through it is refused", async () => {
    const node = (extra: Json[]): Json =>
      entity("Node", [
        table("nodes"),
        longId,
        { "field.string": { name: "label" } },
        { "field.long": { name: "parentId" } },
        pk,
        { "identity.reference": { name: "fkParent", "@fields": "parentId", "@references": "Node" } },
        ...extra,
      ]);
    const model = await build([node([{ "measure.aggregate": { name: "nodes", "@agg": "count", "@of": "Node.id" } }])]);
    expect(cube(model, "Node").joins).toEqual([]);

    const err = await buildError([
      node([{ "dimension.attribute": { name: "parentLabel", "@of": "Node.label", "@via": "Node.fkParent" } }]),
    ]);
    expect(err.code).toBe("ERR_CUBE_UNMAPPABLE_DIMENSION");
    expect(err.message).toContain("dimension 'acme::shop::Node.parentLabel'");
    expect(err.message).toContain("itself");
  });

  test("a @via onto an entity with no table is refused", async () => {
    const err = await buildError([
      entity("Program", [longId, { "field.string": { name: "title" } }, pk]),
      week([programTitle]),
    ]);
    expect(err.code).toBe("ERR_CUBE_UNMAPPABLE_DIMENSION");
    expect(err.message).toContain("'acme::shop::Program'");
    expect(err.message).toContain("no table");
  });
});

// ---------------------------------------------------------------------------
// Table G — names, collisions and escaping this stage enforces
// ---------------------------------------------------------------------------

describe("Table G — names and escaping", () => {
  test("ERR_CUBE_INVALID_NAME: a member named with a Python keyword", async () => {
    const err = await buildError([program([{ "dimension.attribute": { name: "from", "@of": "Program.title" } }])]);
    expect(err.code).toBe("ERR_CUBE_INVALID_NAME");
    expect(err.message).toStartWith("ERR_CUBE_INVALID_NAME: ");
    expect(err.message).toContain("dimension 'acme::shop::Program.from'");
    expect(err.message).toContain("Python keyword");
  });

  test("ERR_CUBE_INVALID_NAME: a member starting with an underscore", async () => {
    const err = await buildError([program([{ "dimension.attribute": { name: "_t", "@of": "Program.title" } }])]);
    expect(err.code).toBe("ERR_CUBE_INVALID_NAME");
    expect(err.message).toContain("'_t'");
  });

  test("ERR_CUBE_MEMBER_COLLISION: two declared members of one name", async () => {
    const err = await buildError([
      program([
        { "dimension.attribute": { name: "t", "@of": "Program.title" } },
        { "measure.aggregate": { name: "t", "@agg": "count", "@of": "Program.id" } },
      ]),
    ]);
    expect(err.code).toBe("ERR_CUBE_MEMBER_COLLISION");
    expect(err.message).toContain("dimension 'acme::shop::Program.t'");
    expect(err.message).toContain("measure 'acme::shop::Program.t'");
  });

  test("ERR_CUBE_MEMBER_COLLISION: a reached member against a declared one", async () => {
    const err = await buildError([
      program([{ "measure.aggregate": { name: "title", "@agg": "count", "@of": "Program.id" } }]),
      week([{ "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Week.fkProgram" } }]),
    ]);
    expect(err.code).toBe("ERR_CUBE_MEMBER_COLLISION");
    expect(err.message).toContain("cube 'Program'");
    expect(err.message).toContain("measure 'acme::shop::Program.title'");
    expect(err.message).toContain("acme::shop::Week.programTitle");
  });

  test("ERR_CUBE_NAME_COLLISION: two entities of one name in two packages", async () => {
    const counted = (pkg: string): Json =>
      rootOf(
        [entity("Program", [table(`${pkg}_programs`), longId, pk, { "measure.aggregate": { name: "n", "@agg": "count", "@of": "Program.id" } }])],
        `acme::${pkg}`,
      );
    const root = await loadRoots(counted("a"), counted("b"));
    let err: unknown;
    try {
      buildCubeModel(root, { dialect: "postgres", columnNamingStrategy: "literal" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CubeModelError);
    expect((err as CubeModelError).code).toBe("ERR_CUBE_NAME_COLLISION");
    expect((err as CubeModelError).message).toContain("'acme::a::Program'");
    expect((err as CubeModelError).message).toContain("'acme::b::Program'");
  });

  async function segmentSql(value: string, dialect: CubeDialect = "postgres"): Promise<string> {
    const model = await build([program([{ "segment.filter": { name: "s", "@filter": { title: value } } }])], { dialect });
    return cube(model, "Program").segments[0]!.sql;
  }

  test("a literal's braces are escaped for Cube's reference syntax", async () => {
    expect(await segmentSql("a{b}c")).toBe(String.raw`{CUBE}."title" = 'a\{b\}c'`);
    expect(await segmentSql("{{x}}")).toBe(String.raw`{CUBE}."title" = '\{\{x\}\}'`);
  });

  test("a literal holding a Jinja statement or comment is wrapped in raw, braces escaped", async () => {
    expect(await segmentSql("{% z %}")).toBe(String.raw`{CUBE}."title" = {% raw %}'\{% z %\}'{% endraw %}`);
    expect(await segmentSql("{# c #}")).toBe(String.raw`{CUBE}."title" = {% raw %}'\{# c #\}'{% endraw %}`);
  });

  test("SQL quoting comes first: quotes doubled, and MySQL also doubles backslashes", async () => {
    expect(await segmentSql("it's")).toBe(`{CUBE}."title" = 'it''s'`);
    expect(await segmentSql(String.raw`a\b`, "mysql")).toBe(String.raw`{CUBE}.` + "`title`" + String.raw` = 'a\\b'`);
  });

  test("ERR_CUBE_UNESCAPABLE_LITERAL: a literal containing endraw", async () => {
    let err: unknown;
    try {
      await segmentSql("x endraw y");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CubeModelError);
    expect((err as CubeModelError).code).toBe("ERR_CUBE_UNESCAPABLE_LITERAL");
    expect((err as CubeModelError).message).toContain("segment 'acme::shop::Program.s'");
    expect((err as CubeModelError).message).toContain("endraw");
  });

  test("an identifier's braces are escaped too", async () => {
    const model = await build([
      entity("Thing", [
        table("things"),
        longId,
        { "field.string": { name: "code", "@column": "co{de}" } },
        pk,
        { "dimension.attribute": { name: "code", "@of": "Thing.code" } },
      ]),
    ]);
    expect(cube(model, "Thing").dimensions[1]!.sql).toBe(String.raw`{CUBE}."co\{de\}"`);
  });
});

// ---------------------------------------------------------------------------
// Table H — the canonical model's data (rollups and the scope segment are Task 3's)
// ---------------------------------------------------------------------------

describe("Table H — the canonical model", () => {
  // test → codegen-ts → packages → typescript → server → repo root
  const CANONICAL = resolve(
    import.meta.dir, "..", "..", "..", "..", "..", "..",
    "fixtures", "persistence-conformance", "canonical", "meta.fitness.json",
  );

  test("Program, Week and Asset are Table H's cubes", async () => {
    const result = await loadUris([pathToFileURL(CANONICAL).href]);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const model = buildCubeModel(result.root, { dialect: "postgres", columnNamingStrategy: "literal" });
    expect(model.views).toEqual([]);
    expect(model.cubes).toEqual([
      {
        name: "Program",
        sqlTable: '"programs"',
        joins: [],
        dimensions: [
          { name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true },
          {
            name: "createdAt", sql: '{CUBE}."created_ts"', type: "time",
            meta: { grains: ["day", "week", "month", "quarter", "year"] },
          },
          { name: "status", sql: '{CUBE}."status"', type: "string" },
          { name: "title", sql: '{CUBE}."title"', type: "string", public: false },
        ],
        measures: [
          {
            name: "listValue", sql: '{CUBE}."priceCents"', type: "sum",
            filters: [{ sql: `{CUBE}."status" = 'PUBLISHED'` }],
          },
          { name: "programs", sql: '{CUBE}."id"', type: "count" },
        ],
        segments: [{ name: "published", sql: `{CUBE}."status" = 'PUBLISHED'` }],
        preAggregations: [],
      },
      {
        name: "Week",
        sqlTable: '"weeks"',
        joins: [{ name: "Program", relationship: "many_to_one", sql: '{CUBE}."programId" = {Program}."id"' }],
        dimensions: [
          { name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true },
          { name: "program", sql: '{CUBE}."programId"', type: "number" },
          { name: "programTitle", sql: "{Program.title}", type: "string" },
        ],
        measures: [
          { name: "weeks", sql: '{CUBE}."id"', type: "count" },
          {
            name: "longWeeks", sql: '{CUBE}."id"', type: "count",
            filters: [{ sql: '{CUBE}."durationMinutes" >= 60' }],
          },
          { name: "labels", sql: '{CUBE}."label"', type: "count_distinct" },
          {
            name: "slots", sql: 'ROW({CUBE}."programId", {CUBE}."durationMinutes")', type: "count_distinct",
            filters: [{ sql: '{CUBE}."programId" IS NOT NULL AND {CUBE}."durationMinutes" IS NOT NULL' }],
          },
          { name: "totalMinutes", sql: '{CUBE}."durationMinutes"', type: "sum" },
          { name: "avgMinutes", sql: '{CUBE}."durationMinutes"', type: "avg" },
          { name: "minMinutes", sql: '{CUBE}."durationMinutes"', type: "min" },
          { name: "maxMinutes", sql: '{CUBE}."durationMinutes"', type: "max" },
          { name: "longShare", sql: "CAST({longWeeks} AS NUMERIC) / NULLIF({weeks}, 0)", type: "number" },
        ],
        segments: [{ name: "long", sql: '{CUBE}."durationMinutes" >= 60' }],
        preAggregations: [],
      },
      {
        name: "Asset",
        sqlTable: '"assets"',
        joins: [],
        dimensions: [
          { name: "id", sql: '{CUBE}."id"', type: "string", primaryKey: true },
          { name: "recordedAt", sql: '{CUBE}."recordedAt"', type: "time", meta: { grains: ["hour", "day"] } },
          {
            name: "asOfDate", sql: 'CAST({CUBE}."asOfDate" AS TIMESTAMP)', type: "time",
            meta: { grains: ["week", "month"] },
          },
        ],
        measures: [{ name: "assets", sql: '{CUBE}."id"', type: "count" }],
        segments: [],
        preAggregations: [],
      },
    ]);
  });
});
