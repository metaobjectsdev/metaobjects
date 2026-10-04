// FR-044 Plan 2 Task 5 — emitReportViewDdl. Specs are hand-built (not extracted): this
// file pins the TEXT of contract Tables C, E, F and the golden bodies of Table G.
import { describe, test, expect } from "bun:test";
import type { TimeGrain } from "@metaobjectsdev/metadata";
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
