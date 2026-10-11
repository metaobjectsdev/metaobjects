// FR-044 Plan 4, Task 9 — a measure's `@default` (the zero-rows / measure-defaults build, its
// Tables A, D and E). The view reads `COALESCE(E, n)` for a defaulted measure, and a ratio's
// operand carries its own default into the ratio (decision 4). Cube gets the same meaning:
//
//   - a measure.aggregate with `@default: n` is two members: `<m>Raw`, the plan's Table D aggregate
//     (type, sql and filters unchanged), `public: false`; and `<m>` itself, `type: number`,
//     `COALESCE({<m>Raw}, n)`.
//   - a measure.ratio with `@default: n` is `COALESCE(<the quotient>, n)`.
//   - a ratio's operand is a member reference, so an operand with its own default is read through
//     its COALESCE.
//
// Every model is loaded with the real loader.

import { describe, test, expect } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";
import { CubeModelError } from "../../src/cube/cube-errors.js";
import type { CubeDialect, CubeMeasureSpec, CubeModel, CubeSpec } from "../../src/cube/cube-model-spec.js";
import { extractReportSpec } from "../../src/projection/extract-report-spec.js";
import { emitReportViewDdl } from "../../src/projection/report-ddl-emit.js";

type Json = Record<string, unknown>;

const PKG = "acme::shop";

const pk: Json = { "identity.primary": { name: "id", "@fields": "id" } };

/** Sale: a table, a key, an amount (decimal), a quantity and a count; `extra` children go last. */
function sale(extra: Json[] = []): Json {
  return {
    "object.entity": {
      name: "Sale",
      children: [
        { "source.rdb": { "@table": "sales" } },
        { "field.long": { name: "id" } },
        { "field.decimal": { name: "amount", "@precision": 12, "@scale": 2 } },
        { "field.int": { name: "quantity" } },
        pk,
        { "segment.filter": { name: "big", "@filter": { quantity: { gte: 10 } } } },
        { "measure.aggregate": { name: "sales", "@agg": "count", "@of": "Sale.id" } },
        ...extra,
      ],
    },
  };
}

function report(name: string, measures: string[], dimensions: string[] = []): Json {
  return {
    "object.report": {
      name,
      "@from": "Sale",
      ...(dimensions.length > 0 ? { "@dimensions": dimensions } : {}),
      "@measures": measures,
      children: [{ "source.rdb": { "@kind": "view", "@view": `v_${name.toLowerCase()}` } }],
    },
  };
}

async function load(children: Json[]): Promise<MetaRoot> {
  const model = { "metadata.root": { package: PKG, children } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

async function build(children: Json[], dialect: CubeDialect = "postgres"): Promise<CubeModel> {
  return buildCubeModel(await load(children), { dialect, columnNamingStrategy: "literal" });
}

function cube(model: CubeModel, name: string): CubeSpec {
  const hit = model.cubes.find((c) => c.name === name);
  if (hit === undefined) throw new Error(`no cube ${name}`);
  return hit;
}

async function measures(extra: Json[], dialect: CubeDialect = "postgres"): Promise<readonly CubeMeasureSpec[]> {
  return cube(await build([sale(extra)], dialect), "Sale").measures;
}

const revenue = (attrs: Json = {}): Json => ({
  "measure.aggregate": { name: "revenue", "@agg": "sum", "@of": "Sale.amount", ...attrs },
});

describe("measure.aggregate with @default", () => {
  test("is <m>Raw (the aggregate, public: false) and <m> (COALESCE over it, type number), in that order", async () => {
    expect(await measures([revenue({ "@default": 0 })])).toEqual([
      { name: "sales", sql: '{CUBE}."id"', type: "count" },
      { name: "revenueRaw", sql: '{CUBE}."amount"', type: "sum", public: false },
      { name: "revenue", sql: "COALESCE({revenueRaw}, 0)", type: "number" },
    ]);
  });

  test("the aggregate keeps its condition on <m>Raw; <m> has none of its own", async () => {
    const got = await measures([
      { "measure.aggregate": { name: "bigUnits", "@agg": "sum", "@of": "Sale.quantity", "@segment": "big", "@default": 0 } },
    ]);
    expect(got.slice(1)).toEqual([
      { name: "bigUnitsRaw", sql: '{CUBE}."quantity"', type: "sum", filters: [{ sql: '{CUBE}."quantity" >= 10' }], public: false },
      { name: "bigUnits", sql: "COALESCE({bigUnitsRaw}, 0)", type: "number" },
    ]);
  });

  test.each(["avg", "min", "max"] as const)("%s over a number, with a negative sentinel default", async (agg) => {
    const got = await measures([{ "measure.aggregate": { name: "m", "@agg": agg, "@of": "Sale.quantity", "@default": -1 } }]);
    expect(got.slice(1)).toEqual([
      { name: "mRaw", sql: '{CUBE}."quantity"', type: agg, public: false },
      { name: "m", sql: "COALESCE({mRaw}, -1)", type: "number" },
    ]);
  });

  test("the measure's title and description stay on <m>, the member a report lists", async () => {
    const got = await measures([revenue({ "@default": 0, "@title": "Revenue", "@description": "0 when there is none." })]);
    expect(got.slice(1)).toEqual([
      { name: "revenueRaw", sql: '{CUBE}."amount"', type: "sum", public: false },
      { name: "revenue", sql: "COALESCE({revenueRaw}, 0)", type: "number", title: "Revenue", description: "0 when there is none." },
    ]);
  });

  test("a defaulted measure inherited from an abstract base gets both members on the concrete cube", async () => {
    const model = await build([
      {
        "object.entity": {
          name: "BaseSale",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "field.int": { name: "quantity" } },
            pk,
            { "measure.aggregate": { name: "units", "@agg": "sum", "@of": "BaseSale.quantity", "@default": 0 } },
          ],
        },
      },
      { "object.entity": { name: "Sale", extends: "BaseSale", children: [{ "source.rdb": { "@table": "sales" } }] } },
    ]);
    expect(cube(model, "Sale").measures).toEqual([
      { name: "unitsRaw", sql: '{CUBE}."quantity"', type: "sum", public: false },
      { name: "units", sql: "COALESCE({unitsRaw}, 0)", type: "number" },
    ]);
  });

  test("ERR_CUBE_MEMBER_COLLISION: a declared member named <m>Raw, declared after the measure", async () => {
    const err = await refusal([
      sale([revenue({ "@default": 0 }), { "measure.aggregate": { name: "revenueRaw", "@agg": "count", "@of": "Sale.id" } }]),
    ]);
    expect(err.code).toBe("ERR_CUBE_MEMBER_COLLISION");
    expect(err.message).toBe(
      "ERR_CUBE_MEMBER_COLLISION: cube 'Sale': the measure 'revenueRaw' the exporter adds for the @default of " +
        "measure 'acme::shop::Sale.revenue' and measure 'acme::shop::Sale.revenueRaw' are both named 'revenueRaw', " +
        "and a cube's dimensions, measures, segments and pre-aggregations share one namespace. Rename one of them in " +
        "the model.",
    );
  });

  test("ERR_CUBE_MEMBER_COLLISION: a declared member named <m>Raw, declared before the measure", async () => {
    const err = await refusal([
      sale([{ "dimension.attribute": { name: "revenueRaw", "@of": "Sale.amount" } }, revenue({ "@default": 0 })]),
    ]);
    expect(err.code).toBe("ERR_CUBE_MEMBER_COLLISION");
    expect(err.message).toContain(
      "dimension 'acme::shop::Sale.revenueRaw' and the measure 'revenueRaw' the exporter adds for the @default " +
        "of measure 'acme::shop::Sale.revenue' are both named 'revenueRaw'",
    );
  });

  test("a rollup lists <m>, never <m>Raw", async () => {
    const model = await build([sale([revenue({ "@default": 0 })]), report("SaleTotals", ["sales", "revenue"])]);
    expect(cube(model, "Sale").preAggregations).toEqual([
      { name: "SaleTotals", type: "rollup", measures: ["sales", "revenue"], dimensions: [], segments: [] },
    ]);
  });
});

describe("measure.ratio with @default", () => {
  const perSale = (attrs: Json = {}): Json => ({
    "measure.ratio": { name: "perSale", "@numerator": "revenue", "@denominator": "sales", ...attrs },
  });

  test("Postgres: COALESCE around the cast quotient", async () => {
    const got = await measures([revenue(), perSale({ "@default": 0 })]);
    expect(got[2]).toEqual({ name: "perSale", sql: "COALESCE(CAST({revenue} AS NUMERIC) / NULLIF({sales}, 0), 0)", type: "number" });
  });

  test("MySQL: COALESCE around the quotient, no cast", async () => {
    const got = await measures([revenue(), perSale({ "@default": 0 })], "mysql");
    expect(got[2]).toEqual({ name: "perSale", sql: "COALESCE({revenue} / NULLIF({sales}, 0), 0)", type: "number" });
  });

  test("a ratio declares no <m>Raw: its own default wraps the quotient", async () => {
    const got = await measures([revenue(), perSale({ "@default": 7 })]);
    expect(got.map((m) => m.name)).toEqual(["sales", "revenue", "perSale"]);
    expect(got[2]!.sql).toBe("COALESCE(CAST({revenue} AS NUMERIC) / NULLIF({sales}, 0), 7)");
  });

  test("an operand with its own @default is read through its COALESCE member, when the ratio declares none", async () => {
    const got = await measures([revenue({ "@default": 0 }), perSale()]);
    expect(got.slice(1)).toEqual([
      { name: "revenueRaw", sql: '{CUBE}."amount"', type: "sum", public: false },
      { name: "revenue", sql: "COALESCE({revenueRaw}, 0)", type: "number" },
      { name: "perSale", sql: "CAST({revenue} AS NUMERIC) / NULLIF({sales}, 0)", type: "number" },
    ]);
  });
});

/**
 * A measure as Cube computes it, its member references expanded: `count` and `sum` become the
 * aggregate over the column (no condition here), a `number` measure its SQL with each `{member}`
 * replaced by that member's expansion. `{CUBE}` becomes `alias`, as Cube's SQL aliases the cube.
 */
function expand(c: CubeSpec, name: string, alias: string): string {
  const m = c.measures.find((x) => x.name === name);
  if (m === undefined) throw new Error(`no measure ${name}`);
  if (m.filters !== undefined) throw new Error(`${name}: the expander does not render conditions`);
  const sql = m.sql.replaceAll("{CUBE}", alias);
  switch (m.type) {
    case "count":
      return `COUNT(${sql})`;
    case "sum":
      return `SUM(${sql})`;
    case "number":
      return sql.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_all, member: string) => expand(c, member, alias));
    default:
      throw new Error(`${name}: the expander does not render ${m.type}`);
  }
}

/** The SELECT expression the report view lowering writes for `column` of `reportName`. */
function viewExpression(root: MetaRoot, reportName: string, column: string): string {
  const report = root.objects().find((o) => o.name === reportName)!;
  const spec = extractReportSpec(report, root, { columnNamingStrategy: "literal" });
  const body = emitReportViewDdl(spec, { dialect: "postgres", baseTableName: "sales", joinTables: {}, bodyOnly: true });
  const line = body.split("\n").find((l) => l.trimEnd().endsWith(` AS "${column}",`) || l.trimEnd().endsWith(` AS "${column}"`));
  if (line === undefined) throw new Error(`no column ${column} in:\n${body}`);
  return line.trim().replace(new RegExp(` AS "${column}",?$`), "");
}

describe("an operand's @default reaches the ratio (decision 4): Cube's expansion is the view's own SQL", () => {
  // `amount` is a decimal, so the view writes its sum with no cast and the two can be compared
  // character for character once `{CUBE}` is the view's alias `s`.
  const model = [
    sale([
      revenue({ "@default": 0 }),
      { "measure.ratio": { name: "perSale", "@numerator": "revenue", "@denominator": "sales" } },
      { "measure.ratio": { name: "perSaleOrZero", "@numerator": "revenue", "@denominator": "sales", "@default": 0 } },
    ]),
    report("SaleRatios", ["perSale", "perSaleOrZero"]),
  ];

  test.each(["perSale", "perSaleOrZero"])("%s", async (ratio) => {
    const root = await load(model);
    const c = cube(buildCubeModel(root, { dialect: "postgres", columnNamingStrategy: "literal" }), "Sale");
    const cubeMeaning = expand(c, ratio, "s");
    // The operand's COALESCE is inside the quotient, and the view agrees exactly.
    expect(cubeMeaning).toContain('CAST(COALESCE(SUM(s."amount"), 0) AS NUMERIC)');
    expect(cubeMeaning).toBe(viewExpression(root, "SaleRatios", ratio));
  });

  test("the expansions, written out", async () => {
    const c = cube(await build(model), "Sale");
    expect(expand(c, "perSale", "s")).toBe('CAST(COALESCE(SUM(s."amount"), 0) AS NUMERIC) / NULLIF(COUNT(s."id"), 0)');
    expect(expand(c, "perSaleOrZero", "s")).toBe(
      'COALESCE(CAST(COALESCE(SUM(s."amount"), 0) AS NUMERIC) / NULLIF(COUNT(s."id"), 0), 0)',
    );
  });
});

async function refusal(children: Json[]): Promise<CubeModelError> {
  try {
    await build(children);
  } catch (e) {
    if (e instanceof CubeModelError) return e;
    throw e;
  }
  throw new Error("expected a CubeModelError, and the build succeeded");
}
