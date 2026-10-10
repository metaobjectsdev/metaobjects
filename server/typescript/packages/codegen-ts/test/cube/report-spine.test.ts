// FR-044 Plan 4, Task 10 — a served report with `@spine` (the zero-rows / measure-defaults build,
// its Table D). The view selects FROM the spine entity and LEFT JOINs the facts, with the report's
// scope in the join, so a spine row whose facts are all filtered out keeps its row. Cube gets the
// same rows from:
//
//   - a Cube VIEW named after the report (`model/views/<Report>.yml`), whose first `cubes` entry
//     is the spine cube and whose last is the report's facts cube; no rollup;
//   - a standalone `public: false` facts cube `<Report>Facts` over @from's table, scoped by the
//     report's @segment and @filter in its own `sql` (so the scope sits in the join, never in a
//     WHERE on the outer query), holding the report's measures and what they read;
//   - ONE one_to_many join from the spine cube to it (and, for a multi-hop spine, standalone chain
//     cubes `<Report>_<hop>` in between). No reverse join is added to an ordinary cube's own
//     facts, so every ad-hoc answer of the ordinary cubes is unchanged.
//
// Executed on Cube 1.7.43 before this was built: the view includes a private primary key and a
// `public: false` member under aliases, its include-level docs and meta reach /v1/meta, the
// roster view returns every program with `weeks` 0 for the empty ones, the scoped facts cube keeps
// the programs whose weeks are all short, a two-hop chain returns the view lowering's rows, and
// `{ Week.weeks, Program.id }` stays rooted at Week. Every model is loaded with the real loader.

import { describe, test, expect } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";
import { CubeModelError } from "../../src/cube/cube-errors.js";
import type { CubeModel, CubeSpec, CubeViewSpec } from "../../src/cube/cube-model-spec.js";

type Json = Record<string, unknown>;

const PKG = "acme::shop";

const longId: Json = { "field.long": { name: "id" } };
const pk: Json = { "identity.primary": { name: "id", "@fields": "id" } };
const table = (name: string): Json => ({ "source.rdb": { "@table": name } });

function entity(name: string, children: Json[], extra: Json = {}): Json {
  return { "object.entity": { name, ...extra, children } };
}

function report(name: string, attrs: Json, source = true): Json {
  return {
    "object.report": {
      name,
      ...attrs,
      children: source ? [{ "source.rdb": { "@kind": "view", "@view": `v_${name.toLowerCase()}` } }] : [],
    },
  };
}

const program = (extra: Json[] = []): Json =>
  entity("Program", [table("programs"), longId, { "field.string": { name: "title" } }, pk, ...extra]);

/** Week, the canonical model's fact entity in small: a reference onto Program, and its measures. */
const week = (extra: Json[] = []): Json =>
  entity("Week", [
    table("weeks"),
    longId,
    { "field.long": { name: "programId", "@required": true } },
    { "field.int": { name: "durationMinutes", "@required": true } },
    pk,
    { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
    { "segment.filter": { name: "long", "@filter": { durationMinutes: { gte: 60 } } } },
    { "dimension.attribute": { name: "programKey", "@of": "Program.id", "@via": "Week.fkProgram" } },
    { "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Week.fkProgram" } },
    { "measure.aggregate": { name: "weeks", "@agg": "count", "@of": "Week.id" } },
    { "measure.aggregate": { name: "longWeeks", "@agg": "count", "@of": "Week.id", "@segment": "long" } },
    { "measure.aggregate": { name: "totalMinutes", "@agg": "sum", "@of": "Week.durationMinutes" } },
    { "measure.aggregate": { name: "totalMinutesOrZero", "@agg": "sum", "@of": "Week.durationMinutes", "@default": 0 } },
    { "measure.ratio": { name: "longShare", "@numerator": "longWeeks", "@denominator": "weeks" } },
    { "measure.ratio": { name: "longShareOrZero", "@numerator": "longWeeks", "@denominator": "weeks", "@default": 0 } },
    ...extra,
  ]);

const roster = (attrs: Json = {}): Json =>
  report("ProgramRoster", {
    "@from": "Week",
    "@spine": "Week.fkProgram",
    "@dimensions": ["programKey", "programTitle"],
    "@measures": ["weeks", "totalMinutes", "totalMinutesOrZero", "longShare", "longShareOrZero"],
    ...attrs,
  });

const longWeeks = (attrs: Json = {}): Json =>
  report("ProgramLongWeeks", {
    "@from": "Week",
    "@spine": "Week.fkProgram",
    "@dimensions": ["programKey"],
    "@measures": ["weeks", "totalMinutesOrZero"],
    "@segment": "long",
    ...attrs,
  });

async function load(roots: Json[][]): Promise<MetaRoot> {
  const sources = roots.map((children, i) => {
    const pkg = i === 0 ? PKG : `acme::other${String(i)}`;
    return new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: pkg, children } }));
  });
  const { root, errors } = await new MetaDataLoader().load(sources);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

async function build(children: Json[], opts: { matches?: (name: string) => boolean; more?: Json[][] } = {}): Promise<CubeModel> {
  const root = await load([children, ...(opts.more ?? [])]);
  const matches = opts.matches;
  return buildCubeModel(root, {
    dialect: "postgres",
    columnNamingStrategy: "literal",
    ...(matches !== undefined ? { matches: (o) => matches(o.name) } : {}),
  });
}

async function buildError(children: Json[], more: Json[][] = []): Promise<CubeModelError> {
  try {
    await build(children, { more });
  } catch (e) {
    if (e instanceof CubeModelError) return e;
    throw e;
  }
  throw new Error("expected a CubeModelError, and the build succeeded");
}

function cube(model: CubeModel, name: string): CubeSpec {
  const hit = model.cubes.find((c) => c.name === name);
  if (hit === undefined) throw new Error(`no cube ${name} in [${model.cubes.map((c) => c.name).join(", ")}]`);
  return hit;
}

function view(model: CubeModel, name: string): CubeViewSpec {
  const hit = model.views.find((v) => v.name === name);
  if (hit === undefined) throw new Error(`no view ${name} in [${model.views.map((v) => v.name).join(", ")}]`);
  return hit;
}

const key = { name: "id", sql: '{CUBE}."id"', type: "number", primaryKey: true } as const;

describe("a one-hop @spine report", () => {
  test("is a view rooted at the spine cube, then its facts cube", async () => {
    const model = await build([program(), week(), roster()]);
    expect(model.views).toEqual([
      {
        name: "ProgramRoster",
        cubes: [
          {
            joinPath: "Program",
            includes: [
              { name: "id", alias: "programKey" },
              { name: "title", alias: "programTitle" },
            ],
          },
          {
            joinPath: "Program.ProgramRosterFacts",
            includes: [
              { name: "weeks" },
              { name: "totalMinutes" },
              { name: "totalMinutesOrZero" },
              { name: "longShare" },
              { name: "longShareOrZero" },
            ],
          },
        ],
      },
    ]);
  });

  test("its facts cube is standalone over @from's table, with the measures it lists and what they read", async () => {
    const model = await build([program(), week(), roster()]);
    expect(cube(model, "ProgramRosterFacts")).toEqual({
      name: "ProgramRosterFacts",
      sql: 'SELECT * FROM "weeks" w',
      public: false,
      joins: [],
      dimensions: [key],
      // @from's measures in its own order, narrowed to the listed ones, the ratios' operands and the
      // defaulted measure's <m>Raw; what the report does not list is public: false.
      measures: [
        { name: "weeks", sql: '{CUBE}."id"', type: "count" },
        { name: "longWeeks", sql: '{CUBE}."id"', type: "count", filters: [{ sql: '{CUBE}."durationMinutes" >= 60' }], public: false },
        { name: "totalMinutes", sql: '{CUBE}."durationMinutes"', type: "sum" },
        { name: "totalMinutesOrZeroRaw", sql: '{CUBE}."durationMinutes"', type: "sum", public: false },
        { name: "totalMinutesOrZero", sql: "COALESCE({totalMinutesOrZeroRaw}, 0)", type: "number" },
        { name: "longShare", sql: "CAST({longWeeks} AS NUMERIC) / NULLIF({weeks}, 0)", type: "number" },
        { name: "longShareOrZero", sql: "COALESCE(CAST({longWeeks} AS NUMERIC) / NULLIF({weeks}, 0), 0)", type: "number" },
      ],
      segments: [],
      preAggregations: [],
    });
  });

  test("the spine cube joins the facts cube one_to_many on the spine hop's columns", async () => {
    const model = await build([program(), week(), roster()]);
    expect(cube(model, "Program").joins).toEqual([
      { name: "ProgramRosterFacts", relationship: "one_to_many", sql: '{CUBE}."id" = {ProgramRosterFacts}."programId"' },
    ]);
  });

  test("no rollup, no scope segment, and no reverse join: the ordinary fact cube is what it was", async () => {
    const withSpine = await build([program(), week(), roster({ "@filter": { durationMinutes: { gte: 10 } } })]);
    const without = await build([program(), week()]);
    expect(cube(withSpine, "Week")).toEqual(cube(without, "Week"));
    expect(cube(withSpine, "Week").preAggregations).toEqual([]);
    expect(cube(withSpine, "Week").joins).toEqual([
      { name: "Program", relationship: "many_to_one", sql: '{CUBE}."programId" = {Program}."id"' },
    ]);
  });

  test("the report's @segment scopes the facts inside the facts cube's sql, never in a WHERE on the view", async () => {
    const model = await build([program(), week(), longWeeks()]);
    expect(cube(model, "ProgramLongWeeksFacts").sql).toBe('SELECT * FROM "weeks" w WHERE w."durationMinutes" >= 60');
    expect(cube(model, "ProgramLongWeeksFacts").measures.map((m) => [m.name, m.public])).toEqual([
      ["weeks", undefined],
      ["totalMinutesOrZeroRaw", false],
      ["totalMinutesOrZero", undefined],
    ]);
    expect(view(model, "ProgramLongWeeks").cubes.at(-1)).toEqual({
      joinPath: "Program.ProgramLongWeeksFacts",
      includes: [{ name: "weeks" }, { name: "totalMinutesOrZero" }],
    });
  });

  test("@segment then @filter, ANDed as the view's join condition is", async () => {
    const model = await build([program(), week(), longWeeks({ "@filter": { programId: { ne: 3 } } })]);
    expect(cube(model, "ProgramLongWeeksFacts").sql).toBe(
      'SELECT * FROM "weeks" w WHERE (w."durationMinutes" >= 60 AND w."programId" <> 3)',
    );
  });

  test("two @spine reports onto one spine cube each get their own facts cube and join, in report order", async () => {
    const model = await build([program(), week(), roster(), longWeeks()]);
    expect(cube(model, "Program").joins.map((j) => j.name)).toEqual(["ProgramRosterFacts", "ProgramLongWeeksFacts"]);
    expect(model.views.map((v) => v.name)).toEqual(["ProgramRoster", "ProgramLongWeeks"]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Program", "Week", "ProgramRosterFacts", "ProgramLongWeeksFacts"]);
  });

  test("the spine cube is the entity's own when it has vocabulary of its own", async () => {
    const model = await build([
      program([{ "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } }]),
      week(),
      roster(),
    ]);
    expect(cube(model, "Program").public).toBeUndefined();
    expect(cube(model, "Program").joins.map((j) => j.name)).toEqual(["ProgramRosterFacts"]);
    expect(cube(model, "Program").measures.map((m) => m.name)).toEqual(["programs"]);
  });

  test("the report's docs are the view's, and a dimension's docs and grains are its include's", async () => {
    const model = await build([
      program([{ "field.timestamp": { name: "createdAt" } }]),
      week([
        {
          "dimension.time": {
            name: "programCreated", "@of": "Program.createdAt", "@via": "Week.fkProgram", "@grains": ["month", "year"],
            "@title": "Created", "@description": "When the program was created.",
          },
        },
      ]),
      report("ProgramsByMonth", {
        "@from": "Week",
        "@spine": "Week.fkProgram",
        "@dimensions": ["programKey", "programCreated:month"],
        "@measures": ["weeks"],
        "@title": "Programs by month",
        "@description": "Every program, by the month it was created.",
      }),
    ]);
    expect(view(model, "ProgramsByMonth")).toEqual({
      name: "ProgramsByMonth",
      title: "Programs by month",
      description: "Every program, by the month it was created.",
      cubes: [
        {
          joinPath: "Program",
          includes: [
            { name: "id", alias: "programKey" },
            {
              name: "createdAt", alias: "programCreated", title: "Created", description: "When the program was created.",
              meta: { grains: ["month", "year"] },
            },
          ],
        },
        { joinPath: "Program.ProgramsByMonthFacts", includes: [{ name: "weeks" }] },
      ],
    });
  });

  test("a dimension past the spine is included from the cube its own join path ends on", async () => {
    const model = await build([
      entity("Org", [table("orgs"), longId, { "field.string": { name: "name" } }, pk]),
      program([
        { "field.long": { name: "orgId" } },
        { "identity.reference": { name: "fkOrg", "@fields": "orgId", "@references": "Org" } },
      ]),
      week([{ "dimension.attribute": { name: "orgName", "@of": "Org.name", "@via": "Week.fkProgram.fkOrg" } }]),
      report("OrgRoster", {
        "@from": "Week",
        "@spine": "Week.fkProgram",
        "@dimensions": ["programKey", "orgName"],
        "@measures": ["weeks"],
      }),
    ]);
    expect(view(model, "OrgRoster").cubes).toEqual([
      { joinPath: "Program", includes: [{ name: "id", alias: "programKey" }] },
      { joinPath: "Program.Org", includes: [{ name: "name", alias: "orgName" }] },
      { joinPath: "Program.OrgRosterFacts", includes: [{ name: "weeks" }] },
    ]);
    expect(cube(model, "Program").joins.map((j) => [j.name, j.relationship])).toEqual([
      ["Org", "many_to_one"],
      ["OrgRosterFacts", "one_to_many"],
    ]);
  });

  test("a dimension named like the member it reads needs no alias", async () => {
    const model = await build([
      program(),
      week([{ "dimension.attribute": { name: "title", "@of": "Program.title", "@via": "Week.fkProgram" } }]),
      report("Titles", { "@from": "Week", "@spine": "Week.fkProgram", "@dimensions": ["title"], "@measures": ["weeks"] }),
    ]);
    expect(view(model, "Titles").cubes[0]).toEqual({ joinPath: "Program", includes: [{ name: "title" }] });
  });
});

describe("other spine shapes", () => {
  test("a self-referencing spine is rooted at the hop's alias cube, which joins the facts", async () => {
    const model = await build([
      entity("Node", [
        table("nodes"),
        longId,
        { "field.string": { name: "label" } },
        { "field.long": { name: "parentId" } },
        pk,
        { "identity.reference": { name: "fkParent", "@fields": "parentId", "@references": "Node" } },
        { "dimension.attribute": { name: "parentKey", "@of": "Node.id", "@via": "Node.fkParent" } },
        { "dimension.attribute": { name: "parentLabel", "@of": "Node.label", "@via": "Node.fkParent" } },
        { "measure.aggregate": { name: "children", "@agg": "count", "@of": "Node.id" } },
      ]),
      report("NodeChildren", {
        "@from": "Node",
        "@spine": "Node.fkParent",
        "@dimensions": ["parentKey", "parentLabel"],
        "@measures": ["children"],
      }),
    ]);
    expect(cube(model, "Node_fkParent").joins).toEqual([
      { name: "NodeChildrenFacts", relationship: "one_to_many", sql: '{CUBE}."id" = {NodeChildrenFacts}."parentId"' },
    ]);
    expect(cube(model, "NodeChildrenFacts").sql).toBe('SELECT * FROM "nodes" n');
    expect(view(model, "NodeChildren").cubes).toEqual([
      { joinPath: "Node_fkParent", includes: [{ name: "id", alias: "parentKey" }, { name: "label", alias: "parentLabel" }] },
      { joinPath: "Node_fkParent.NodeChildrenFacts", includes: [{ name: "children" }] },
    ]);
  });

  test("a hop whose reference the spine entity holds joins back on that entity's foreign key", async () => {
    // Program.profile is to-one, and Profile holds the reference: the facts are Programs, the rows
    // Profiles, and the join runs from Profile's foreign key to the program key.
    const model = await build([
      entity("Profile", [
        table("profiles"),
        longId,
        { "field.long": { name: "programId" } },
        { "field.string": { name: "headline" } },
        pk,
        { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
      ]),
      program([
        { "relationship.association": { name: "profile", "@objectRef": "Profile", "@cardinality": "one" } },
        { "dimension.attribute": { name: "headline", "@of": "Profile.headline", "@via": "Program.profile" } },
        { "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } },
      ]),
      report("ProfilePrograms", { "@from": "Program", "@spine": "Program.profile", "@dimensions": ["headline"], "@measures": ["programs"] }),
    ]);
    expect(cube(model, "Profile").joins).toEqual([
      { name: "Program", relationship: "many_to_one", sql: '{CUBE}."programId" = {Program}."id"' },
      { name: "ProfileProgramsFacts", relationship: "one_to_many", sql: '{CUBE}."programId" = {ProfileProgramsFacts}."id"' },
    ]);
  });

  test("a two-hop spine walks back through a chain cube <Report>_<hop>", async () => {
    const model = await build([
      program(),
      entity("Week", [
        table("weeks"),
        longId,
        { "field.long": { name: "programId" } },
        pk,
        { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
      ]),
      entity("Session", [
        table("sessions"),
        longId,
        { "field.long": { name: "weekId" } },
        { "field.int": { name: "minutes" } },
        pk,
        { "identity.reference": { name: "fkWeek", "@fields": "weekId", "@references": "Week" } },
        { "dimension.attribute": { name: "programKey", "@of": "Program.id", "@via": "Session.fkWeek.fkProgram" } },
        { "measure.aggregate": { name: "sessions", "@agg": "count", "@of": "Session.id" } },
        { "measure.aggregate": { name: "minutesTotal", "@agg": "sum", "@of": "Session.minutes" } },
      ]),
      report("ProgramSessions", {
        "@from": "Session",
        "@spine": "Session.fkWeek.fkProgram",
        "@dimensions": ["programKey"],
        "@measures": ["sessions", "minutesTotal"],
        "@filter": { minutes: { gte: 10 } },
      }),
    ]);
    expect(cube(model, "Program").joins).toEqual([
      { name: "ProgramSessions_fkWeek", relationship: "one_to_many", sql: '{CUBE}."id" = {ProgramSessions_fkWeek}."programId"' },
    ]);
    expect(cube(model, "ProgramSessions_fkWeek")).toEqual({
      name: "ProgramSessions_fkWeek",
      sqlTable: '"weeks"',
      public: false,
      joins: [
        { name: "ProgramSessionsFacts", relationship: "one_to_many", sql: '{CUBE}."id" = {ProgramSessionsFacts}."weekId"' },
      ],
      dimensions: [key],
      measures: [],
      segments: [],
      preAggregations: [],
    });
    expect(cube(model, "ProgramSessionsFacts").sql).toBe('SELECT * FROM "sessions" s WHERE s."minutes" >= 10');
    expect(view(model, "ProgramSessions").cubes).toEqual([
      { joinPath: "Program", includes: [{ name: "id", alias: "programKey" }] },
      {
        joinPath: "Program.ProgramSessions_fkWeek.ProgramSessionsFacts",
        includes: [{ name: "sessions" }, { name: "minutesTotal" }],
      },
    ]);
    // The ordinary Week cube, a join target, gains nothing.
    expect(cube(model, "Week").joins.map((j) => j.name)).toEqual(["Program"]);
  });

  test("a TPH subtype @from scopes its facts by the discriminator, then the report's scope", async () => {
    const model = await build([
      program(),
      entity("Auth", [
        table("auths"),
        longId,
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
        { "field.long": { name: "programId" } },
        { "field.int": { name: "quantity" } },
        pk,
        { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
      ], { "@discriminator": "type" }),
      entity("BridgeAuth", [
        { "dimension.attribute": { name: "programKey", "@of": "Program.id", "@via": "BridgeAuth.fkProgram" } },
        { "measure.aggregate": { name: "auths", "@agg": "count", "@of": "BridgeAuth.id" } },
      ], { extends: "Auth", "@discriminatorValue": "Bridge" }),
      report("ProgramBridges", {
        "@from": "BridgeAuth",
        "@spine": "BridgeAuth.fkProgram",
        "@dimensions": ["programKey"],
        "@measures": ["auths"],
        "@filter": { quantity: { gt: 0 } },
      }),
    ]);
    expect(cube(model, "ProgramBridgesFacts").sql).toBe(
      `SELECT * FROM "auths" b WHERE (b."type" = 'Bridge' AND b."quantity" > 0)`,
    );
  });
});

describe("what stays inert", () => {
  test("a sourceless @spine report adds nothing", async () => {
    const model = await build([program(), week(), report("ProgramRoster", {
      "@from": "Week", "@spine": "Week.fkProgram", "@dimensions": ["programKey"], "@measures": ["weeks"],
    }, false)]);
    expect(model.views).toEqual([]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Program", "Week"]);
    expect(cube(model, "Program").joins).toEqual([]);
  });

  test("a @spine report whose @from the generator's filter leaves out adds nothing", async () => {
    const model = await build(
      [program([{ "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } }]), week(), roster()],
      { matches: (n) => n === "Program" },
    );
    expect(model.views).toEqual([]);
    expect(model.cubes.map((c) => c.name)).toEqual(["Program"]);
  });
});

describe("refusals", () => {
  test("ERR_CUBE_UNMAPPABLE_REPORT: a served @spine report whose @from has no table, naming what it would hold", async () => {
    const err = await buildError([
      program([{ "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } }]),
      entity("Loose", [
        longId,
        { "field.long": { name: "programId" } },
        pk,
        { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
        { "dimension.attribute": { name: "programKey", "@of": "Program.id", "@via": "Loose.fkProgram" } },
        { "measure.aggregate": { name: "loose", "@agg": "count", "@of": "Loose.id" } },
      ]),
      report("LooseRoster", { "@from": "Loose", "@spine": "Loose.fkProgram", "@dimensions": ["programKey"], "@measures": ["loose"] }),
    ]);
    expect(err.code).toBe("ERR_CUBE_UNMAPPABLE_REPORT");
    expect(err.message).toContain(
      "report 'acme::shop::LooseRoster' is served, and its @from 'acme::shop::Loose' has no cube to hold its facts: " +
        "'acme::shop::Loose' declares no writable source.rdb",
    );
  });
});

describe("names", () => {
  test("ERR_CUBE_NAME_COLLISION: an entity named like a report's facts cube", async () => {
    const err = await buildError([
      program(),
      week(),
      roster(),
      entity("ProgramRosterFacts", [table("prf"), longId, pk, { "measure.aggregate": { name: "n", "@agg": "count", "@of": "ProgramRosterFacts.id" } }]),
    ]);
    expect(err.code).toBe("ERR_CUBE_NAME_COLLISION");
    expect(err.message).toContain("entity 'acme::shop::ProgramRosterFacts' and the facts cube 'ProgramRosterFacts' of report 'acme::shop::ProgramRoster'");
  });

  test("ERR_CUBE_NAME_COLLISION: a view and a cube share Cube's one namespace", async () => {
    const err = await buildError(
      [program(), week(), roster()],
      [[entity("ProgramRoster", [table("rosters"), longId, pk, { "measure.aggregate": { name: "n", "@agg": "count", "@of": "ProgramRoster.id" } }])]],
    );
    expect(err.code).toBe("ERR_CUBE_NAME_COLLISION");
    expect(err.message).toContain("entity 'acme::other1::ProgramRoster' and the view 'ProgramRoster' of report 'acme::shop::ProgramRoster'");
  });
});
