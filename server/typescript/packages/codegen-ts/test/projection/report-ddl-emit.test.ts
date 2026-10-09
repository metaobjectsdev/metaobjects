// FR-044 Plan 2 Task 5 — emitReportViewDdl. Specs are hand-built (not extracted): this
// file pins the TEXT of contract Tables C, E, F and the golden bodies of Table G.
import { describe, test, expect } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type TimeGrain } from "@metaobjectsdev/metadata";
import { buildReportViews } from "../../src/projection/build-projection-views.js";
import { emitReportViewDdl, type ReportEmitOptions } from "../../src/projection/report-ddl-emit.js";
import { emitViewDdl } from "../../src/projection/view-ddl-emit.js";
import type {
  ReportAggregate,
  ReportColumn,
  ReportViewSpec,
} from "../../src/projection/report-spec.js";
import type { JoinNode, ViewFilterClause, ViewSpec } from "../../src/projection/view-spec.js";

const pg = (baseTableName: string, joinTables: Record<string, string> = {}): ReportEmitOptions =>
  ({ dialect: "postgres", baseTableName, joinTables, bodyOnly: true });
const sqlite = (baseTableName: string, joinTables: Record<string, string> = {}): ReportEmitOptions =>
  ({ dialect: "sqlite", baseTableName, joinTables, bodyOnly: true });
const mysql = (baseTableName: string, joinTables: Record<string, string> = {}): ReportEmitOptions =>
  ({ dialect: "mysql", baseTableName, joinTables, bodyOnly: true });

const lines = (...l: string[]): string => l.join("\n");

const cmp = (ref: string, op: string, value: unknown): ViewFilterClause => ({ kind: "cmp", ref, op, value });
const count = (ref: string, extra: Partial<ReportAggregate> = {}): ReportAggregate =>
  ({ agg: "count", distinct: false, refs: [ref], ...extra });
const col = (fieldName: string, aggregate: ReportAggregate): ReportColumn =>
  ({ kind: "aggregate", fieldName, dbColAlias: fieldName, aggregate });

function baseSpec(
  alias: string,
  entity: string,
  columns: readonly ReportColumn[],
  rest: { joins?: readonly JoinNode[]; where?: ViewFilterClause; viewName?: string } = {},
): ReportViewSpec {
  return {
    viewName: rest.viewName ?? "v_test",
    joinTree: { baseEntity: entity, baseAlias: alias, joins: rest.joins ?? [] },
    columns,
    ...(rest.where !== undefined ? { where: rest.where } : {}),
  };
}

// ── v_program_minutes (Table G, all three dialects) ────────────────────────────────

const longWeek = cmp("w.durationMinutes", "gte", 60);
const programJoin: JoinNode = {
  relationship: "program", targetEntity: "Program", alias: "p", cardinality: "one",
  fkColumn: "programId", pkColumn: "id", referenceHolder: "source", joinType: "inner", children: [],
};
const programMinutes: ReportViewSpec = baseSpec(
  "w",
  "Week",
  [
    { kind: "dimension", fieldName: "program", dbColAlias: "program", ref: "w.programId" },
    { kind: "dimension", fieldName: "programTitle", dbColAlias: "programTitle", ref: "p.title" },
    col("weeks", count("w.id")),
    col("longWeeks", count("w.id", { filter: longWeek })),
    col("labels", count("w.label", { distinct: true })),
    col("slots", count("w.programId", { distinct: true, refs: ["w.programId", "w.durationMinutes"] })),
    col("totalMinutes", { agg: "sum", distinct: false, refs: ["w.durationMinutes"], cast: "bigint" }),
    col("avgMinutes", { agg: "avg", distinct: false, refs: ["w.durationMinutes"] }),
    col("minMinutes", { agg: "min", distinct: false, refs: ["w.durationMinutes"] }),
    col("maxMinutes", { agg: "max", distinct: false, refs: ["w.durationMinutes"] }),
    {
      kind: "ratio", fieldName: "longShare", dbColAlias: "longShare",
      numerator: count("w.id", { filter: longWeek }), denominator: count("w.id"),
    },
  ],
  { joins: [programJoin], viewName: "v_program_minutes" },
);

describe("emitReportViewDdl — Table G v_program_minutes", () => {
  const tables = { Program: "programs" };

  test("postgres", () => {
    expect(emitReportViewDdl(programMinutes, pg("weeks", tables))).toBe(lines(
      `  SELECT`,
      `    w."programId" AS "program",`,
      `    p."title" AS "programTitle",`,
      `    COUNT(w."id") AS "weeks",`,
      `    COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS "longWeeks",`,
      `    COUNT(DISTINCT w."label") AS "labels",`,
      `    COUNT(DISTINCT (w."programId", w."durationMinutes")) FILTER (WHERE w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL) AS "slots",`,
      `    CAST(SUM(w."durationMinutes") AS BIGINT) AS "totalMinutes",`,
      `    AVG(w."durationMinutes") AS "avgMinutes",`,
      `    MIN(w."durationMinutes") AS "minMinutes",`,
      `    MAX(w."durationMinutes") AS "maxMinutes",`,
      `    CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0) AS "longShare"`,
      `  FROM "weeks" w`,
      `  INNER JOIN "programs" p ON p."id" = w."programId"`,
      `  GROUP BY w."programId", p."title"`,
    ));
  });

  test("sqlite", () => {
    expect(emitReportViewDdl(programMinutes, sqlite("weeks", tables))).toBe(lines(
      `  SELECT`,
      `    w."programId" AS "program",`,
      `    p."title" AS "programTitle",`,
      `    COUNT(w."id") AS "weeks",`,
      `    COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS "longWeeks",`,
      `    COUNT(DISTINCT w."label") AS "labels",`,
      `    COUNT(DISTINCT CASE WHEN w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL THEN json_array(w."programId", w."durationMinutes") END) AS "slots",`,
      `    SUM(w."durationMinutes") AS "totalMinutes",`,
      `    AVG(w."durationMinutes") AS "avgMinutes",`,
      `    MIN(w."durationMinutes") AS "minMinutes",`,
      `    MAX(w."durationMinutes") AS "maxMinutes",`,
      `    CAST(COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS REAL) / NULLIF(COUNT(w."id"), 0) AS "longShare"`,
      `  FROM "weeks" w`,
      `  INNER JOIN "programs" p ON p."id" = w."programId"`,
      `  GROUP BY w."programId", p."title"`,
    ));
  });

  test("mysql", () => {
    expect(emitReportViewDdl(programMinutes, mysql("weeks", tables))).toBe(lines(
      "  SELECT",
      "    w.`programId` AS `program`,",
      "    p.`title` AS `programTitle`,",
      "    COUNT(w.`id`) AS `weeks`,",
      "    COUNT(CASE WHEN w.`durationMinutes` >= 60 THEN w.`id` END) AS `longWeeks`,",
      "    COUNT(DISTINCT w.`label`) AS `labels`,",
      "    COUNT(DISTINCT w.`programId`, w.`durationMinutes`) AS `slots`,",
      "    CAST(SUM(w.`durationMinutes`) AS SIGNED) AS `totalMinutes`,",
      "    AVG(w.`durationMinutes`) AS `avgMinutes`,",
      "    MIN(w.`durationMinutes`) AS `minMinutes`,",
      "    MAX(w.`durationMinutes`) AS `maxMinutes`,",
      "    COUNT(CASE WHEN w.`durationMinutes` >= 60 THEN w.`id` END) / NULLIF(COUNT(w.`id`), 0) AS `longShare`",
      "  FROM `weeks` w",
      "  INNER JOIN `programs` p ON p.`id` = w.`programId`",
      "  GROUP BY w.`programId`, p.`title`",
    ));
  });
});

// created_ts is a NAIVE timestamp (@localTime) in the canonical model; recordedAt is an instant.
// ── The other five canonical views, Postgres (Table G) ─────────────────────────────

const totalsSpec: ReportViewSpec = baseSpec(
  "w",
  "Week",
  [
    col("weeks", count("w.id")),
    col("totalMinutes", { agg: "sum", distinct: false, refs: ["w.durationMinutes"], cast: "bigint" }),
    {
      kind: "ratio", fieldName: "longShare", dbColAlias: "longShare",
      numerator: count("w.id", { filter: longWeek }), denominator: count("w.id"),
    },
  ],
  { viewName: "v_fitness_totals" },
);

const byMonthSpec: ReportViewSpec = baseSpec(
  "p",
  "Program",
  [
    {
      kind: "timeDimension", fieldName: "createdAtMonth", dbColAlias: "createdAtMonth",
      ref: "p.created_ts", grain: "month" as TimeGrain, temporal: "naive",
    },
    { kind: "dimension", fieldName: "status", dbColAlias: "status", ref: "p.status" },
    col("programs", count("p.id")),
    col("listValue", {
      agg: "sum", distinct: false, refs: ["p.priceCents"], cast: "bigint",
      filter: cmp("p.status", "eq", "PUBLISHED"),
    }),
  ],
  { viewName: "v_programs_by_month" },
);

const byWeekSpec: ReportViewSpec = baseSpec(
  "p",
  "Program",
  [
    {
      kind: "timeDimension", fieldName: "createdAtWeek", dbColAlias: "createdAtWeek",
      ref: "p.created_ts", grain: "week" as TimeGrain, temporal: "naive",
    },
    col("programs", count("p.id")),
  ],
  { where: cmp("p.status", "eq", "PUBLISHED"), viewName: "v_programs_by_week" },
);

const recentSpec: ReportViewSpec = baseSpec(
  "p",
  "Program",
  [col("programs", count("p.id"))],
  {
    where: cmp("p.created_ts", "gte", { kind: "relativeNow", duration: "-P30D", temporal: "naive" }),
    viewName: "v_recent_programs",
  },
);

const assetActivitySpec: ReportViewSpec = baseSpec(
  "a",
  "Asset",
  [
    {
      kind: "timeDimension", fieldName: "recordedAtHour", dbColAlias: "recordedAtHour",
      ref: "a.recordedAt", grain: "hour" as TimeGrain, temporal: "instant",
    },
    {
      kind: "timeDimension", fieldName: "asOfDateWeek", dbColAlias: "asOfDateWeek",
      ref: "a.asOfDate", grain: "week" as TimeGrain, temporal: "date",
    },
    col("assets", count("a.id")),
  ],
  { viewName: "v_asset_activity" },
);

describe("emitReportViewDdl — Table G, remaining Postgres bodies", () => {
  test("v_fitness_totals", () => {
    expect(emitReportViewDdl(totalsSpec, pg("weeks"))).toBe(lines(
      `  SELECT`,
      `    COUNT(w."id") AS "weeks",`,
      `    CAST(SUM(w."durationMinutes") AS BIGINT) AS "totalMinutes",`,
      `    CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0) AS "longShare"`,
      `  FROM "weeks" w`,
    ));
  });

  test("v_programs_by_month", () => {
    expect(emitReportViewDdl(byMonthSpec, pg("programs"))).toBe(lines(
      `  SELECT`,
      `    CAST(date_trunc('month', p."created_ts") AS DATE) AS "createdAtMonth",`,
      `    p."status" AS "status",`,
      `    COUNT(p."id") AS "programs",`,
      `    CAST(SUM(p."priceCents") FILTER (WHERE p."status" = 'PUBLISHED') AS BIGINT) AS "listValue"`,
      `  FROM "programs" p`,
      `  GROUP BY CAST(date_trunc('month', p."created_ts") AS DATE), p."status"`,
    ));
  });

  test("v_programs_by_week", () => {
    expect(emitReportViewDdl(byWeekSpec, pg("programs"))).toBe(lines(
      `  SELECT`,
      `    CAST(date_trunc('week', p."created_ts") AS DATE) AS "createdAtWeek",`,
      `    COUNT(p."id") AS "programs"`,
      `  FROM "programs" p`,
      `  WHERE p."status" = 'PUBLISHED'`,
      `  GROUP BY CAST(date_trunc('week', p."created_ts") AS DATE)`,
    ));
  });

  test("v_recent_programs", () => {
    expect(emitReportViewDdl(recentSpec, pg("programs"))).toBe(lines(
      `  SELECT`,
      `    COUNT(p."id") AS "programs"`,
      `  FROM "programs" p`,
      `  WHERE p."created_ts" >= ((now() AT TIME ZONE 'UTC') - INTERVAL 'P30D')`,
    ));
  });

  test("v_asset_activity", () => {
    expect(emitReportViewDdl(assetActivitySpec, pg("assets"))).toBe(lines(
      `  SELECT`,
      `    date_trunc('hour', a."recordedAt", 'UTC') AS "recordedAtHour",`,
      `    CAST(date_trunc('week', CAST(a."asOfDate" AS TIMESTAMP)) AS DATE) AS "asOfDateWeek",`,
      `    COUNT(a."id") AS "assets"`,
      `  FROM "assets" a`,
      `  GROUP BY date_trunc('hour', a."recordedAt", 'UTC'), CAST(date_trunc('week', CAST(a."asOfDate" AS TIMESTAMP)) AS DATE)`,
    ));
  });
});

// ── One test per rule ──────────────────────────────────────────────────────────────

function specWithMeasure(name: string): ReportViewSpec {
  return baseSpec("p", "Program", [col(name, count("p.id"))]);
}

describe("emitReportViewDdl — rules", () => {
  test("quotes a keyword-named measure and dimension", () => {
    expect(emitReportViewDdl(specWithMeasure("order"), pg("programs"))).toContain(`AS "order"`);
    expect(emitReportViewDdl(specWithMeasure("order"), sqlite("programs"))).toContain(`AS "order"`);
    expect(emitReportViewDdl(specWithMeasure("order"), mysql("programs"))).toContain("AS `order`");
    const dim = baseSpec("p", "Program", [
      { kind: "dimension", fieldName: "group", dbColAlias: "group", ref: "p.user" },
      col("rank", count("p.id")),
    ]);
    const sql = emitReportViewDdl(dim, pg("programs"));
    expect(sql).toContain(`p."user" AS "group"`);
    expect(sql).toContain(`AS "rank"`);
    expect(sql).toContain(`GROUP BY p."user"`);
  });

  test("quotes an embedded quote character in an identifier", () => {
    expect(emitReportViewDdl(specWithMeasure(`a"b`), pg("programs"))).toContain(`AS "a""b"`);
    expect(emitReportViewDdl(specWithMeasure("a`b"), mysql("programs"))).toContain("AS `a``b`");
  });

  test("no dimensions: no GROUP BY", () => {
    expect(emitReportViewDdl(totalsSpec, pg("weeks"))).not.toContain("GROUP BY");
  });

  test("a time dimension groups by the same expression it selects", () => {
    const sql = emitReportViewDdl(byMonthSpec, pg("programs"));
    const expr = `CAST(date_trunc('month', p."created_ts") AS DATE)`;
    expect(sql).toContain(`${expr} AS "createdAtMonth"`);
    expect(sql).toContain(`GROUP BY ${expr}, p."status"`);
  });

  test("a relative value renders Table E inside WHERE", () => {
    expect(emitReportViewDdl(recentSpec, pg("programs")))
      .toContain(`WHERE p."created_ts" >= ((now() AT TIME ZONE 'UTC') - INTERVAL 'P30D')`);
    expect(emitReportViewDdl(recentSpec, sqlite("programs")))
      .toContain(`WHERE p."created_ts" >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '-30 days')`);
    expect(emitReportViewDdl(recentSpec, mysql("programs")))
      .toContain("WHERE p.`created_ts` >= (UTC_TIMESTAMP(3) - INTERVAL 30 DAY)");
  });

  test("a relative value inside an `in` list renders Table E per element", () => {
    const spec = baseSpec("p", "Program", [col("programs", count("p.id"))], {
      where: cmp("p.created_ts", "in", [{ kind: "relativeNow", duration: "-P1D", temporal: "naive" }, "x"]),
    });
    expect(emitReportViewDdl(spec, pg("programs")))
      .toContain(`WHERE p."created_ts" IN (((now() AT TIME ZONE 'UTC') - INTERVAL 'P1D'), 'x')`);
  });

  const tupleCondSpec: ReportViewSpec = baseSpec("w", "Week", [
    col("slots", count("w.programId", {
      distinct: true,
      refs: ["w.programId", "w.durationMinutes"],
      filter: longWeek,
    })),
  ]);

  test("a tuple distinct count with a condition, per dialect", () => {
    expect(emitReportViewDdl(tupleCondSpec, pg("weeks"))).toContain(
      `COUNT(DISTINCT (w."programId", w."durationMinutes")) FILTER (WHERE w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL AND w."durationMinutes" >= 60)`);
    expect(emitReportViewDdl(tupleCondSpec, sqlite("weeks"))).toContain(
      `COUNT(DISTINCT CASE WHEN w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL AND w."durationMinutes" >= 60 THEN json_array(w."programId", w."durationMinutes") END)`);
    expect(emitReportViewDdl(tupleCondSpec, mysql("weeks"))).toContain(
      "COUNT(DISTINCT CASE WHEN w.`durationMinutes` >= 60 THEN w.`programId` END, w.`durationMinutes`)");
  });

  test("a distinct count with a condition", () => {
    const spec = baseSpec("w", "Week", [col("labels", count("w.label", { distinct: true, filter: longWeek }))]);
    expect(emitReportViewDdl(spec, pg("weeks")))
      .toContain(`COUNT(DISTINCT w."label") FILTER (WHERE w."durationMinutes" >= 60)`);
    expect(emitReportViewDdl(spec, sqlite("weeks")))
      .toContain(`COUNT(DISTINCT CASE WHEN w."durationMinutes" >= 60 THEN w."label" END)`);
    expect(emitReportViewDdl(spec, mysql("weeks")))
      .toContain("COUNT(DISTINCT CASE WHEN w.`durationMinutes` >= 60 THEN w.`label` END)");
  });

  test("Table C casts: bigint and double sums, per dialect", () => {
    const big = baseSpec("w", "Week", [
      col("t", { agg: "sum", distinct: false, refs: ["w.m"], cast: "bigint" }),
    ]);
    const dbl = baseSpec("w", "Week", [
      col("t", { agg: "sum", distinct: false, refs: ["w.m"], cast: "double" }),
    ]);
    const dec = baseSpec("w", "Week", [col("t", { agg: "sum", distinct: false, refs: ["w.m"] })]);
    expect(emitReportViewDdl(big, pg("weeks"))).toContain(`CAST(SUM(w."m") AS BIGINT)`);
    expect(emitReportViewDdl(big, sqlite("weeks"))).toContain(`    SUM(w."m") AS "t"`);
    expect(emitReportViewDdl(big, mysql("weeks"))).toContain("CAST(SUM(w.`m`) AS SIGNED)");
    expect(emitReportViewDdl(dbl, pg("weeks"))).toContain(`CAST(SUM(w."m") AS DOUBLE PRECISION)`);
    expect(emitReportViewDdl(dbl, sqlite("weeks"))).toContain(`    SUM(w."m") AS "t"`);
    expect(emitReportViewDdl(dbl, mysql("weeks"))).toContain("    SUM(w.`m`) AS `t`");
    expect(emitReportViewDdl(dec, pg("weeks"))).toContain(`    SUM(w."m") AS "t"`);
  });

  test("a conditional cast sum: the cast wraps the FILTER, per dialect", () => {
    const spec = baseSpec("w", "Week", [
      col("t", { agg: "sum", distinct: false, refs: ["w.m"], cast: "bigint", filter: longWeek }),
    ]);
    expect(emitReportViewDdl(spec, pg("weeks")))
      .toContain(`CAST(SUM(w."m") FILTER (WHERE w."durationMinutes" >= 60) AS BIGINT)`);
    expect(emitReportViewDdl(spec, sqlite("weeks")))
      .toContain(`SUM(CASE WHEN w."durationMinutes" >= 60 THEN w."m" END)`);
    expect(emitReportViewDdl(spec, mysql("weeks")))
      .toContain("CAST(SUM(CASE WHEN w.`durationMinutes` >= 60 THEN w.`m` END) AS SIGNED)");
  });

  test("a ratio repeats each operand's FULL expression, operand cast nested inside the ratio cast", () => {
    const sumOp: ReportAggregate = {
      agg: "sum", distinct: false, refs: ["w.m"], cast: "bigint", filter: longWeek,
    };
    const sumAll: ReportAggregate = { agg: "sum", distinct: false, refs: ["w.m"], cast: "bigint" };
    const spec = baseSpec("w", "Week", [
      { kind: "ratio", fieldName: "r", dbColAlias: "r", numerator: sumOp, denominator: sumAll },
    ]);
    expect(emitReportViewDdl(spec, pg("weeks"))).toContain(
      `CAST(CAST(SUM(w."m") FILTER (WHERE w."durationMinutes" >= 60) AS BIGINT) AS NUMERIC) / NULLIF(CAST(SUM(w."m") AS BIGINT), 0) AS "r"`);
    expect(emitReportViewDdl(spec, sqlite("weeks"))).toContain(
      `CAST(SUM(CASE WHEN w."durationMinutes" >= 60 THEN w."m" END) AS REAL) / NULLIF(SUM(w."m"), 0) AS "r"`);
    expect(emitReportViewDdl(spec, mysql("weeks"))).toContain(
      "CAST(SUM(CASE WHEN w.`durationMinutes` >= 60 THEN w.`m` END) AS SIGNED) / NULLIF(CAST(SUM(w.`m`) AS SIGNED), 0) AS `r`");
  });

  test("a MySQL string literal doubles backslashes and quotes; the others double only quotes", () => {
    const spec = baseSpec("p", "Program", [col("programs", count("p.id"))], {
      where: cmp("p.label", "eq", "a\\b'c"),
    });
    expect(emitReportViewDdl(spec, mysql("programs"))).toContain("WHERE p.`label` = 'a\\\\b''c'");
    expect(emitReportViewDdl(spec, pg("programs"))).toContain(`WHERE p."label" = 'a\\b''c'`);
    expect(emitReportViewDdl(spec, sqlite("programs"))).toContain(`WHERE p."label" = 'a\\b''c'`);
  });

  test("boolean literals: TRUE/FALSE on Postgres and MySQL, 1/0 on SQLite", () => {
    const spec = baseSpec("p", "Program", [col("programs", count("p.id"))], {
      where: cmp("p.active", "eq", true),
    });
    expect(emitReportViewDdl(spec, pg("programs"))).toContain(`p."active" = TRUE`);
    expect(emitReportViewDdl(spec, mysql("programs"))).toContain("p.`active` = TRUE");
    expect(emitReportViewDdl(spec, sqlite("programs"))).toContain(`p."active" = 1`);
  });

  test("operators: ne, like, in, isNull, and/or grouping", () => {
    const where: ViewFilterClause = {
      kind: "and",
      clauses: [
        cmp("p.a", "ne", 1),
        cmp("p.b", "like", "x%"),
        cmp("p.c", "in", ["u", "v"]),
        cmp("p.d", "isNull", true),
        cmp("p.e", "isNull", false),
        { kind: "or", clauses: [cmp("p.f", "lt", 2), cmp("p.g", "lte", 3)] },
      ],
    };
    const spec = baseSpec("p", "Program", [col("programs", count("p.id"))], { where });
    expect(emitReportViewDdl(spec, pg("programs"))).toContain(
      `WHERE (p."a" <> 1 AND p."b" LIKE 'x%' AND p."c" IN ('u', 'v') AND p."d" IS NULL AND p."e" IS NOT NULL AND (p."f" < 2 OR p."g" <= 3))`);
  });

  test("an exprCmp or unknown operator is refused", () => {
    const bad = baseSpec("p", "Program", [col("programs", count("p.id"))], {
      where: { kind: "exprCmp", expr: { kind: "lit", value: 1 }, op: "eq", value: 1 },
    });
    expect(() => emitReportViewDdl(bad, pg("programs"))).toThrow(/exprCmp/);
    const badOp = baseSpec("p", "Program", [col("programs", count("p.id"))], {
      where: cmp("p.a", "regex", "x"),
    });
    expect(() => emitReportViewDdl(badOp, pg("programs"))).toThrow(/regex/);
  });

  test("a join to an entity with no registered table is refused", () => {
    expect(() => emitReportViewDdl(programMinutes, pg("weeks"))).toThrow(/Program/);
  });

  test("a nested join and a LEFT OUTER join render with their ON clauses", () => {
    const nested: JoinNode = {
      relationship: "program", targetEntity: "Program", alias: "p", cardinality: "one",
      fkColumn: "programId", pkColumn: "id", referenceHolder: "source", joinType: "left",
      children: [{
        relationship: "weeks", targetEntity: "Week", alias: "w0", cardinality: "many",
        fkColumn: "programId", pkColumn: "id", referenceHolder: "target", joinType: "left", children: [],
      }],
    };
    const spec = baseSpec("w", "Week", [col("n", count("w.id"))], { joins: [nested] });
    const sql = emitReportViewDdl(spec, mysql("weeks", { Program: "programs", Week: "weeks" }));
    expect(sql).toContain(lines(
      "  LEFT OUTER JOIN `programs` p ON p.`id` = w.`programId`",
      "  LEFT OUTER JOIN `weeks` w0 ON w0.`programId` = p.`id`",
    ));
  });

  test("bodyOnly false wraps in CREATE VIEW with a quoted name and a trailing semicolon", () => {
    const spec = baseSpec("p", "Program", [col("programs", count("p.id"))], { viewName: "v_x" });
    const full = emitReportViewDdl(spec, { dialect: "postgres", baseTableName: "programs", joinTables: {} });
    expect(full).toBe(`CREATE VIEW "v_x" AS\n  SELECT\n    COUNT(p."id") AS "programs"\n  FROM "programs" p;`);
    const my = emitReportViewDdl(spec, { dialect: "mysql", baseTableName: "programs", joinTables: {}, bodyOnly: false });
    expect(my.startsWith("CREATE VIEW `v_x` AS\n")).toBe(true);
    expect(my.endsWith(";")).toBe(true);
  });

  test("the projection emitter's output is untouched", () => {
    const spec: ViewSpec = {
      viewName: "v_program_summary",
      joinTree: { baseEntity: "Program", baseAlias: "p", joins: [] },
      selectSpec: {
        columns: [
          { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "p", sourceColumn: "id" },
          { kind: "passthrough", fieldName: "title", dbColAlias: "title", sourceAlias: "p", sourceColumn: "title" },
        ],
      },
      groupBy: [],
    };
    // quoteIfNeeded leaves these lower-case identifiers bare; the report emitter would quote them.
    expect(emitViewDdl(spec, { dialect: "postgres", baseTableName: "programs", joinTables: {} })).toBe(
      "CREATE VIEW v_program_summary AS\n  SELECT\n    p.id AS id,\n    p.title AS title\n  FROM programs p;",
    );
  });
});

// ── FR-044 Table D: a measure @default and a report @spine ───────────────────────────

const sumOf = (ref: string, extra: Partial<ReportAggregate> = {}): ReportAggregate =>
  ({ agg: "sum", distinct: false, refs: [ref], ...extra });

describe("emitReportViewDdl — Table D, a measure @default", () => {
  test("COALESCE wraps the cast, per dialect", () => {
    const spec = baseSpec("w", "Week", [
      col("t", sumOf("w.m", { cast: "bigint", defaultValue: { value: 0, real: false } })),
    ]);
    expect(emitReportViewDdl(spec, pg("weeks"))).toContain(`    COALESCE(CAST(SUM(w."m") AS BIGINT), 0) AS "t"`);
    expect(emitReportViewDdl(spec, sqlite("weeks"))).toContain(`    COALESCE(SUM(w."m"), 0) AS "t"`);
    expect(emitReportViewDdl(spec, mysql("weeks"))).toContain("    COALESCE(CAST(SUM(w.`m`) AS SIGNED), 0) AS `t`");
  });

  test("COALESCE wraps the condition too: the full Table C expression is E", () => {
    const spec = baseSpec("w", "Week", [
      col("t", sumOf("w.m", { cast: "bigint", filter: longWeek, defaultValue: { value: 0, real: false } })),
    ]);
    expect(emitReportViewDdl(spec, pg("weeks")))
      .toContain(`COALESCE(CAST(SUM(w."m") FILTER (WHERE w."durationMinutes" >= 60) AS BIGINT), 0) AS "t"`);
    expect(emitReportViewDdl(spec, sqlite("weeks")))
      .toContain(`COALESCE(SUM(CASE WHEN w."durationMinutes" >= 60 THEN w."m" END), 0) AS "t"`);
  });

  test("a negative default: -1, and -1.0 on SQLite only for a real measure", () => {
    const real = baseSpec("w", "Week", [
      col("a", { agg: "avg", distinct: false, refs: ["w.m"], defaultValue: { value: -1, real: true } }),
    ]);
    expect(emitReportViewDdl(real, pg("weeks"))).toContain(`    COALESCE(AVG(w."m"), -1) AS "a"`);
    expect(emitReportViewDdl(real, sqlite("weeks"))).toContain(`    COALESCE(AVG(w."m"), -1.0) AS "a"`);
    expect(emitReportViewDdl(real, mysql("weeks"))).toContain("    COALESCE(AVG(w.`m`), -1) AS `a`");
    const integral = baseSpec("w", "Week", [
      col("t", sumOf("w.m", { cast: "bigint", defaultValue: { value: -1, real: false } })),
    ]);
    expect(emitReportViewDdl(integral, sqlite("weeks"))).toContain(`    COALESCE(SUM(w."m"), -1) AS "t"`);
  });

  test("a defaulted operand inside a ratio keeps its COALESCE, under the ratio's cast", () => {
    const num = sumOf("w.m", { cast: "bigint", defaultValue: { value: 0, real: false } });
    const ratio: ReportColumn = { kind: "ratio", fieldName: "r", dbColAlias: "r", numerator: num, denominator: count("w.id") };
    const spec = baseSpec("w", "Week", [ratio]);
    expect(emitReportViewDdl(spec, pg("weeks"))).toContain(
      `    CAST(COALESCE(CAST(SUM(w."m") AS BIGINT), 0) AS NUMERIC) / NULLIF(COUNT(w."id"), 0) AS "r"`);
    expect(emitReportViewDdl(spec, sqlite("weeks"))).toContain(
      `    CAST(COALESCE(SUM(w."m"), 0) AS REAL) / NULLIF(COUNT(w."id"), 0) AS "r"`);
    expect(emitReportViewDdl(spec, mysql("weeks"))).toContain(
      "    COALESCE(CAST(SUM(w.`m`) AS SIGNED), 0) / NULLIF(COUNT(w.`id`), 0) AS `r`");
    // The ratio's own default wraps the whole quotient, a REAL literal on SQLite.
    const both = baseSpec("w", "Week", [{ ...ratio, defaultValue: 0 }]);
    expect(emitReportViewDdl(both, pg("weeks"))).toContain(
      `    COALESCE(CAST(COALESCE(CAST(SUM(w."m") AS BIGINT), 0) AS NUMERIC) / NULLIF(COUNT(w."id"), 0), 0) AS "r"`);
    expect(emitReportViewDdl(both, sqlite("weeks"))).toContain(
      `    COALESCE(CAST(COALESCE(SUM(w."m"), 0) AS REAL) / NULLIF(COUNT(w."id"), 0), 0.0) AS "r"`);
    expect(emitReportViewDdl(both, mysql("weeks"))).toContain(
      "    COALESCE(COALESCE(CAST(SUM(w.`m`) AS SIGNED), 0) / NULLIF(COUNT(w.`id`), 0), 0) AS `r`");
  });
});

/** Week -> Program, the spine of the hand-built specs below. */
const spineProgram = (children: readonly JoinNode[] = []): JoinNode => ({
  relationship: "fkProgram", targetEntity: "Program", alias: "p", cardinality: "one",
  fkColumn: "programId", pkColumn: "id", referenceHolder: "source", joinType: "left", children,
});

function spineSpec(where: ViewFilterClause | undefined, joins: readonly JoinNode[] = [spineProgram()], spineDepth = 1): ReportViewSpec {
  return {
    ...baseSpec("w", "Week", [
      { kind: "dimension", fieldName: "programTitle", dbColAlias: "programTitle", ref: "p.title" },
      col("weeks", count("w.id")),
    ], where === undefined ? { joins } : { joins, where }),
    spineDepth,
  };
}

describe("emitReportViewDdl — Table D, a report @spine", () => {
  const tables = { Program: "programs", Week: "weeks" };

  test("FROM the spine entity, the hop reversed, the fact table LEFT OUTER, no WHERE", () => {
    expect(emitReportViewDdl(spineSpec(undefined), pg("weeks", tables))).toBe(lines(
      `  SELECT`,
      `    p."title" AS "programTitle",`,
      `    COUNT(w."id") AS "weeks"`,
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"`,
      `  GROUP BY p."title"`,
    ));
  });

  test("the report scope is in the join condition", () => {
    const segmentAndFilter: ViewFilterClause = {
      kind: "and", clauses: [cmp("w.durationMinutes", "gte", 60), cmp("w.label", "eq", "x")],
    };
    const sql = emitReportViewDdl(spineSpec(segmentAndFilter), pg("weeks", tables));
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain(`  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId" AND (w."durationMinutes" >= 60 AND w."label" = 'x')\n`);
    // An `or` scope is parenthesised inside the ON, so it cannot capture the join predicate.
    const or: ViewFilterClause = { kind: "or", clauses: [cmp("w.label", "eq", "a"), cmp("w.label", "eq", "b")] };
    const mySql = emitReportViewDdl(spineSpec(or), mysql("weeks", tables));
    expect(mySql).not.toContain("WHERE");
    expect(mySql).toContain("  LEFT OUTER JOIN `weeks` w ON p.`id` = w.`programId` AND (w.`label` = 'a' OR w.`label` = 'b')\n");
  });

  test("an onward join hangs off the spine alias", () => {
    const owner: JoinNode = {
      relationship: "ownerRef", targetEntity: "Owner", alias: "o", cardinality: "one",
      fkColumn: "ownerId", pkColumn: "id", referenceHolder: "source", joinType: "left", children: [],
    };
    const sql = emitReportViewDdl(spineSpec(undefined, [spineProgram([owner])]), sqlite("weeks", { ...tables, Owner: "owners" }));
    expect(sql).toContain(lines(
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"`,
      `  LEFT OUTER JOIN "owners" o ON o."id" = p."ownerId"`,
    ));
  });

  test("a spec whose join tree is not one chain of spineDepth hops is refused, not half-rendered", () => {
    expect(() => emitReportViewDdl(spineSpec(undefined, [spineProgram()], 2), pg("weeks", tables)))
      .toThrow(/v_test.*@spine/);
    const other: JoinNode = { ...spineProgram(), relationship: "other", alias: "p0" };
    expect(() => emitReportViewDdl(spineSpec(undefined, [spineProgram(), other]), pg("weeks", tables)))
      .toThrow(/v_test.*@spine/);
    expect(() => emitReportViewDdl(spineSpec(undefined, [spineProgram()], 0), pg("weeks", tables)))
      .toThrow(/v_test.*@spine/);
  });

  test("a spine entity with no registered table is refused", () => {
    expect(() => emitReportViewDdl(spineSpec(undefined), pg("weeks", { Week: "weeks" }))).toThrow(/Program/);
  });
});

// ── Table D goldens, end to end: an inline model through buildReportViews ────────────

type Json = Record<string, unknown>;

const tableSrc = (t: string): Json => ({ "source.rdb": { "@table": t } });
const viewSrc = (v: string): Json => ({ "source.rdb": { "@kind": "view", "@view": v } });
const field = (subType: string, name: string, extra: Json = {}): Json => ({ [`field.${subType}`]: { name, ...extra } });
const idPk: Json = { "identity.primary": { name: "id", "@fields": "id" } };
const ent = (name: string, children: Json[]): Json => ({ "object.entity": { name, children } });
const rpt = (name: string, attrs: Json, view: string): Json =>
  ({ "object.report": { name, ...attrs, children: [viewSrc(view)] } });

/** The canonical fitness model's Program and Week, with Table D's three reports (Task 6). */
const fitness = (extra: Json[] = [], programExtra: Json[] = [], weekExtra: Json[] = []): Json[] => [
  ent("Program", [
    tableSrc("programs"),
    field("long", "id"),
    field("string", "title", { "@required": true, "@maxLength": 200 }),
    idPk,
    ...programExtra,
  ]),
  ent("Week", [
    tableSrc("weeks"),
    field("long", "id"),
    field("long", "programId", { "@required": true }),
    field("string", "label", { "@maxLength": 80 }),
    field("int", "durationMinutes", { "@required": true }),
    idPk,
    { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
    { "segment.filter": { name: "long", "@filter": { durationMinutes: { gte: 60 } } } },
    { "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Week.fkProgram" } },
    { "measure.aggregate": { name: "weeks", "@agg": "count", "@of": "Week.id" } },
    { "measure.aggregate": { name: "longWeeks", "@agg": "count", "@of": "Week.id", "@segment": "long" } },
    { "measure.aggregate": { name: "totalMinutes", "@agg": "sum", "@of": "Week.durationMinutes" } },
    { "measure.ratio": { name: "longShare", "@numerator": "longWeeks", "@denominator": "weeks" } },
    { "dimension.attribute": { name: "programKey", "@of": "Program.id", "@via": "Week.fkProgram" } },
    { "measure.aggregate": { name: "totalMinutesOrZero", "@agg": "sum", "@of": "Week.durationMinutes", "@default": 0 } },
    { "measure.ratio": { name: "longShareOrZero", "@numerator": "longWeeks", "@denominator": "weeks", "@default": 0 } },
    ...weekExtra,
  ]),
  rpt("ProgramRoster", {
    "@from": "Week", "@spine": "Week.fkProgram", "@dimensions": ["programKey", "programTitle"],
    "@measures": ["weeks", "totalMinutes", "totalMinutesOrZero", "longShare", "longShareOrZero"],
  }, "v_program_roster"),
  rpt("ProgramLongWeeks", {
    "@from": "Week", "@spine": "Week.fkProgram", "@dimensions": ["programKey"],
    "@measures": ["weeks", "totalMinutesOrZero"], "@segment": "long",
  }, "v_program_long_weeks"),
  rpt("FitnessTotalsFilled", {
    "@from": "Week", "@measures": ["weeks", "totalMinutesOrZero", "longShareOrZero"],
  }, "v_fitness_totals_filled"),
  ...extra,
];

async function viewsOf(children: Json[], dialect: "postgres" | "sqlite" | "d1" | "mysql"): Promise<Record<string, string>> {
  const source = new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "fitness", children } }));
  const { root, errors } = await new MetaDataLoader().load([source]);
  expect(errors).toEqual([]);
  const out: Record<string, string> = {};
  for (const v of buildReportViews(root, { dialect, columnNamingStrategy: "literal" })) out[v.name] = v.sql;
  return out;
}

describe("Table D goldens (the bodies Task 6's canonical reports must produce)", () => {
  test("postgres", async () => {
    const v = await viewsOf(fitness(), "postgres");
    expect(v["v_program_roster"]).toBe(lines(
      `  SELECT`,
      `    p."id" AS "programKey",`,
      `    p."title" AS "programTitle",`,
      `    COUNT(w."id") AS "weeks",`,
      `    CAST(SUM(w."durationMinutes") AS BIGINT) AS "totalMinutes",`,
      `    COALESCE(CAST(SUM(w."durationMinutes") AS BIGINT), 0) AS "totalMinutesOrZero",`,
      `    CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0) AS "longShare",`,
      `    COALESCE(CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0), 0) AS "longShareOrZero"`,
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"`,
      `  GROUP BY p."id", p."title"`,
    ));
    expect(v["v_program_long_weeks"]).toBe(lines(
      `  SELECT`,
      `    p."id" AS "programKey",`,
      `    COUNT(w."id") AS "weeks",`,
      `    COALESCE(CAST(SUM(w."durationMinutes") AS BIGINT), 0) AS "totalMinutesOrZero"`,
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId" AND w."durationMinutes" >= 60`,
      `  GROUP BY p."id"`,
    ));
    expect(v["v_fitness_totals_filled"]).toBe(lines(
      `  SELECT`,
      `    COUNT(w."id") AS "weeks",`,
      `    COALESCE(CAST(SUM(w."durationMinutes") AS BIGINT), 0) AS "totalMinutesOrZero",`,
      `    COALESCE(CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0), 0) AS "longShareOrZero"`,
      `  FROM "weeks" w`,
    ));
  });

  test("sqlite, and d1 identical", async () => {
    const v = await viewsOf(fitness(), "sqlite");
    expect(v["v_program_roster"]).toBe(lines(
      `  SELECT`,
      `    p."id" AS "programKey",`,
      `    p."title" AS "programTitle",`,
      `    COUNT(w."id") AS "weeks",`,
      `    SUM(w."durationMinutes") AS "totalMinutes",`,
      `    COALESCE(SUM(w."durationMinutes"), 0) AS "totalMinutesOrZero",`,
      `    CAST(COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS REAL) / NULLIF(COUNT(w."id"), 0) AS "longShare",`,
      `    COALESCE(CAST(COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS REAL) / NULLIF(COUNT(w."id"), 0), 0.0) AS "longShareOrZero"`,
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"`,
      `  GROUP BY p."id", p."title"`,
    ));
    expect(v["v_program_long_weeks"]).toBe(lines(
      `  SELECT`,
      `    p."id" AS "programKey",`,
      `    COUNT(w."id") AS "weeks",`,
      `    COALESCE(SUM(w."durationMinutes"), 0) AS "totalMinutesOrZero"`,
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId" AND w."durationMinutes" >= 60`,
      `  GROUP BY p."id"`,
    ));
    expect(v["v_fitness_totals_filled"]).toBe(lines(
      `  SELECT`,
      `    COUNT(w."id") AS "weeks",`,
      `    COALESCE(SUM(w."durationMinutes"), 0) AS "totalMinutesOrZero",`,
      `    COALESCE(CAST(COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS REAL) / NULLIF(COUNT(w."id"), 0), 0.0) AS "longShareOrZero"`,
      `  FROM "weeks" w`,
    ));
    expect(await viewsOf(fitness(), "d1")).toEqual(v);
  });

  test("mysql", async () => {
    const v = await viewsOf(fitness(), "mysql");
    expect(v["v_program_roster"]).toBe(lines(
      "  SELECT",
      "    p.`id` AS `programKey`,",
      "    p.`title` AS `programTitle`,",
      "    COUNT(w.`id`) AS `weeks`,",
      "    CAST(SUM(w.`durationMinutes`) AS SIGNED) AS `totalMinutes`,",
      "    COALESCE(CAST(SUM(w.`durationMinutes`) AS SIGNED), 0) AS `totalMinutesOrZero`,",
      "    COUNT(CASE WHEN w.`durationMinutes` >= 60 THEN w.`id` END) / NULLIF(COUNT(w.`id`), 0) AS `longShare`,",
      "    COALESCE(COUNT(CASE WHEN w.`durationMinutes` >= 60 THEN w.`id` END) / NULLIF(COUNT(w.`id`), 0), 0) AS `longShareOrZero`",
      "  FROM `programs` p",
      "  LEFT OUTER JOIN `weeks` w ON p.`id` = w.`programId`",
      "  GROUP BY p.`id`, p.`title`",
    ));
    expect(v["v_program_long_weeks"]).toBe(lines(
      "  SELECT",
      "    p.`id` AS `programKey`,",
      "    COUNT(w.`id`) AS `weeks`,",
      "    COALESCE(CAST(SUM(w.`durationMinutes`) AS SIGNED), 0) AS `totalMinutesOrZero`",
      "  FROM `programs` p",
      "  LEFT OUTER JOIN `weeks` w ON p.`id` = w.`programId` AND w.`durationMinutes` >= 60",
      "  GROUP BY p.`id`",
    ));
    expect(v["v_fitness_totals_filled"]).toBe(lines(
      "  SELECT",
      "    COUNT(w.`id`) AS `weeks`,",
      "    COALESCE(CAST(SUM(w.`durationMinutes`) AS SIGNED), 0) AS `totalMinutesOrZero`,",
      "    COALESCE(COUNT(CASE WHEN w.`durationMinutes` >= 60 THEN w.`id` END) / NULLIF(COUNT(w.`id`), 0), 0) AS `longShareOrZero`",
      "  FROM `weeks` w",
    ));
  });

  test("an onward join from the spine alias is LEFT OUTER even over a required reference", async () => {
    const owner = ent("Owner", [tableSrc("owners"), field("long", "id"), field("string", "name"), idPk]);
    const programRef = [
      field("long", "ownerId", { "@required": true }),
      { "identity.reference": { name: "ownerRef", "@fields": "ownerId", "@references": "Owner" } },
    ];
    const dim = [{ "dimension.attribute": { name: "ownerName", "@of": "Owner.name", "@via": "Week.fkProgram.ownerRef" } }];
    const report = (name: string, spine: boolean): Json => rpt(name, {
      "@from": "Week", ...(spine ? { "@spine": "Week.fkProgram" } : {}),
      "@dimensions": ["programTitle", "ownerName"], "@measures": ["weeks"],
    }, `v_${name}`);
    const v = await viewsOf(fitness([owner, report("Spined", true), report("Plain", false)], programRef, dim), "postgres");
    expect(v["v_Spined"]).toBe(lines(
      `  SELECT`,
      `    p."title" AS "programTitle",`,
      `    o."name" AS "ownerName",`,
      `    COUNT(w."id") AS "weeks"`,
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"`,
      `  LEFT OUTER JOIN "owners" o ON o."id" = p."ownerId"`,
      `  GROUP BY p."title", o."name"`,
    ));
    // The same report without @spine keeps #209: both required hops are INNER.
    expect(v["v_Plain"]).toContain(lines(
      `  FROM "weeks" w`,
      `  INNER JOIN "programs" p ON p."id" = w."programId"`,
      `  INNER JOIN "owners" o ON o."id" = p."ownerId"`,
    ));
  });
});

describe("Table D: the spine chain, end to end", () => {
  /** Program <- Week <- Session (Table D's two-hop case), each hop an identity.reference. */
  const sessions: Json[] = [
    ent("Program", [tableSrc("programs"), field("long", "id"), field("string", "title"), idPk]),
    ent("Week", [
      tableSrc("weeks"), field("long", "id"), field("long", "programId"), idPk,
      { "identity.reference": { name: "program", "@fields": "programId", "@references": "Program" } },
    ]),
    ent("Session", [
      tableSrc("sessions"), field("long", "id"), field("long", "weekId"), field("int", "minutes"), idPk,
      { "identity.reference": { name: "week", "@fields": "weekId", "@references": "Week" } },
      { "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Session.week.program" } },
      { "measure.aggregate": { name: "sessions", "@agg": "count", "@of": "Session.id" } },
    ]),
    rpt("SessionsByProgram", {
      "@from": "Session", "@spine": "Session.week.program", "@dimensions": ["programTitle"],
      "@measures": ["sessions"], "@filter": { minutes: { gte: 10 } },
    }, "v_sessions_by_program"),
  ];

  test("the two-hop chain, per dialect", async () => {
    expect((await viewsOf(sessions, "postgres"))["v_sessions_by_program"]).toBe(lines(
      `  SELECT`,
      `    p."title" AS "programTitle",`,
      `    COUNT(s."id") AS "sessions"`,
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"`,
      `  LEFT OUTER JOIN "sessions" s ON w."id" = s."weekId" AND s."minutes" >= 10`,
      `  GROUP BY p."title"`,
    ));
    expect((await viewsOf(sessions, "sqlite"))["v_sessions_by_program"]).toContain(lines(
      `  FROM "programs" p`,
      `  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"`,
      `  LEFT OUTER JOIN "sessions" s ON w."id" = s."weekId" AND s."minutes" >= 10`,
    ));
    expect((await viewsOf(sessions, "mysql"))["v_sessions_by_program"]).toContain(lines(
      "  FROM `programs` p",
      "  LEFT OUTER JOIN `weeks` w ON p.`id` = w.`programId`",
      "  LEFT OUTER JOIN `sessions` s ON w.`id` = s.`weekId` AND s.`minutes` >= 10",
    ));
  });

  test("a one-to-one hop whose reference is held by the far entity, reversed", async () => {
    // Account.profile is @cardinality one, but the foreign key is Profile.accountId.
    const accounts: Json[] = [
      ent("Account", [
        tableSrc("accounts"), field("long", "id"), idPk,
        { "relationship.association": { name: "profile", "@objectRef": "Profile", "@cardinality": "one" } },
        { "dimension.attribute": { name: "tier", "@of": "Profile.tier", "@via": "Account.profile" } },
        { "measure.aggregate": { name: "accounts", "@agg": "count", "@of": "Account.id" } },
      ]),
      ent("Profile", [
        tableSrc("profiles"), field("long", "id"), field("long", "accountId"), field("string", "tier"), idPk,
        { "identity.reference": { name: "accountRef", "@fields": "accountId", "@references": "Account" } },
      ]),
      rpt("ByTier", { "@from": "Account", "@spine": "Account.profile", "@dimensions": ["tier"], "@measures": ["accounts"] }, "v_by_tier"),
      rpt("ByTierPlain", { "@from": "Account", "@dimensions": ["tier"], "@measures": ["accounts"] }, "v_by_tier_plain"),
    ];
    const v = await viewsOf(accounts, "postgres");
    expect(v["v_by_tier"]).toBe(lines(
      `  SELECT`,
      `    p."tier" AS "tier",`,
      `    COUNT(a."id") AS "accounts"`,
      `  FROM "profiles" p`,
      `  LEFT OUTER JOIN "accounts" a ON p."accountId" = a."id"`,
      `  GROUP BY p."tier"`,
    ));
    // The forward join renders the same predicate: reversing the hop moves no column.
    expect(v["v_by_tier_plain"]).toContain(`  LEFT OUTER JOIN "profiles" p ON p."accountId" = a."id"`);
  });
});
