/**
 * Report arithmetic and money sums, run on real databases.
 *
 * Every other report test either reads the lowered SQL as text or runs a report whose measures
 * are counts and sums of integers. Nothing ran a `measure.derived` (add, subtract, multiply,
 * divide over measures and dimensions), a ratio, or a sum of `field.decimal` money on an engine,
 * so the lowering's casts and its divide-by-zero guard were proved only by reading them.
 *
 * The model is the shared `reporting-derived-measures` conformance fixture. The schema is what
 * `meta migrate` writes for it, tables and the two report views both, applied to an empty
 * database, so the views under test are the ones an adopter gets. The numbers are worked out by
 * hand in the seed comments below.
 *
 *   - Postgres (a real container): NUMERIC is exact, so the money sum is held to its exact text,
 *     the derived values to 1e-9, and a division by a zero or missing denominator to NULL.
 *   - SQLite (bun:sqlite, in memory): has no decimal, so a decimal column is a REAL; the same
 *     rows are held to 1e-9, which is what an engine without a decimal can promise.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { buildExpectedSchema, diff, emit } from "@metaobjectsdev/migrate-ts";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";
import { executeSql, queryRows } from "../src/postgres-sql.ts";
import { CORPUS_DIR } from "../src/paths.ts";
import { splitStatements } from "../src/sql-script.ts";

const FIXTURE = join(CORPUS_DIR, "..", "conformance", "reporting-derived-measures", "input", "meta.studio.json");
const TOLERANCE = 1e-9;

async function loadModel(): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(readFileSync(FIXTURE, "utf8"))]);
  expect(errors).toEqual([]);
  return root;
}

/** The DDL `meta migrate` writes for the model on an empty database: tables, then the report views. */
async function schemaSql(dialect: "postgres" | "sqlite"): Promise<string> {
  const root = await loadModel();
  // The views come from the caller, as  passes them.
  const expected = buildExpectedSchema(root, { dialect, views: buildProjectionViews(root, { dialect }) });
  const result = await diff({ expected, actual: { tables: [], views: [] }, dialect });
  expect(result.blocked).toEqual([]);
  const { up } = emit(result.changes, { dialect });
  expect(up).toContain("v_memberutilization");
  expect(up).toContain("v_projectburn");
  return up;
}

// Members: Ada works 40 hours a week, Bo 20. A year of Ada's weeks over twelve months is
// 40 * 52 / 12 = 173.3333...; Bo's is 20 * 52 / 12 = 86.6666...
// Projects: Alpha has a budget of 1000.00, Beta a budget of 0.00, Gamma none.
// Time entries (hours, cost, billable, day):
//   Ada, Alpha   7.50  0.10  yes  2026-05-04
//   Ada, Alpha   2.50  0.20  yes  2026-05-05
//   Ada, Alpha   5.00  100.05 no  2026-05-06
//   Ada, Alpha   4.00  5.25  yes  2026-06-02
//   Bo,  Beta    3.00  10.00 yes  2026-05-07
//   Bo,  Gamma   1.50  20.00 no   2026-06-01
const SEED = `
INSERT INTO members (id, first_name, weekly_capacity_hours) VALUES (1, 'Ada', 40.00), (2, 'Bo', 20.00);
INSERT INTO projects (id, name, budget) VALUES (1, 'Alpha', 1000.00), (2, 'Beta', 0.00), (3, 'Gamma', NULL);
INSERT INTO time_entries (id, member_id, project_id, hours, cost, billable, worked_on) VALUES
  (1, 1, 1, 7.50,   0.10, {T}, '2026-05-04'),
  (2, 1, 1, 2.50,   0.20, {T}, '2026-05-05'),
  (3, 1, 1, 5.00, 100.05, {F}, '2026-05-06'),
  (4, 1, 1, 4.00,   5.25, {T}, '2026-06-02'),
  (5, 2, 2, 3.00,  10.00, {T}, '2026-05-07'),
  (6, 2, 3, 1.50,  20.00, {F}, '2026-06-01');
`;

const CAPACITY_ADA = (40 * 52) / 12;
const CAPACITY_BO = (20 * 52) / 12;

type Row = Record<string, unknown>;

/** What each member-month must read, worked from the seed above. */
const MEMBER_MONTHS: ReadonlyArray<{ member: string; month: string; values: Record<string, number> }> = [
  {
    member: "Ada", month: "2026-05-01",
    values: {
      total_hours: 15, billable_hours: 10, capacity_hours: CAPACITY_ADA,
      utilization: (10 * 100) / CAPACITY_ADA, non_billable_hours: 5, billable_share_pct: (10 / 15) * 100,
    },
  },
  {
    member: "Ada", month: "2026-06-01",
    values: {
      total_hours: 4, billable_hours: 4, capacity_hours: CAPACITY_ADA,
      utilization: (4 * 100) / CAPACITY_ADA, non_billable_hours: 0, billable_share_pct: 100,
    },
  },
  {
    member: "Bo", month: "2026-05-01",
    values: {
      total_hours: 3, billable_hours: 3, capacity_hours: CAPACITY_BO,
      utilization: (3 * 100) / CAPACITY_BO, non_billable_hours: 0, billable_share_pct: 100,
    },
  },
  {
    // Nothing billable: the filtered sum is empty, so `@default: 0` makes it 0, and 0 over the
    // month's hours is 0, not NULL.
    member: "Bo", month: "2026-06-01",
    values: {
      total_hours: 1.5, billable_hours: 0, capacity_hours: CAPACITY_BO,
      utilization: 0, non_billable_hours: 1.5, billable_share_pct: 0,
    },
  },
];

function monthOf(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function expectMemberMonths(rows: Row[]): void {
  expect(rows.length).toBe(MEMBER_MONTHS.length);
  for (const want of MEMBER_MONTHS) {
    const row = rows.find((r) => r["member_name"] === want.member && monthOf(r["worked_on_month"]) === want.month);
    expect(row, `${want.member} ${want.month}`).toBeDefined();
    for (const [column, value] of Object.entries(want.values)) {
      const got = Number(row![column]);
      expect(Math.abs(got - value), `${want.member} ${want.month} ${column}: got ${got}, want ${value}`).toBeLessThan(TOLERANCE);
    }
  }
}

/** Alpha: 0.10 + 0.20 + 100.05 + 5.25 = 105.60 against a budget of 1000.00, a burn of 0.1056.
 *  Beta: a budget of 0, so the divide-by-zero guard answers NULL. Gamma: no budget, NULL. */
function expectProjectBurn(rows: Row[], exactMoney: boolean): void {
  expect(rows.length).toBe(3);
  const byId = new Map(rows.map((r) => [Number(r["project_id"]), r]));
  const alpha = byId.get(1)!;
  if (exactMoney) expect(String(alpha["cost"])).toBe("105.60");
  expect(Math.abs(Number(alpha["cost"]) - 105.6)).toBeLessThan(TOLERANCE);
  expect(Math.abs(Number(alpha["budget_burn"]) - 0.1056)).toBeLessThan(TOLERANCE);
  const beta = byId.get(2)!;
  expect(Number(beta["cost"])).toBe(10);
  expect(beta["budget_burn"]).toBeNull();
  const gamma = byId.get(3)!;
  expect(Number(gamma["cost"])).toBe(20);
  expect(gamma["budget_burn"]).toBeNull();
}

describe("report arithmetic and money sums, on Postgres", () => {
  let pg: RunningPg;

  beforeAll(async () => {
    pg = await startPostgres();
    await executeSql(pg.connectionUri, await schemaSql("postgres"));
    await executeSql(pg.connectionUri, SEED.replaceAll("{T}", "TRUE").replaceAll("{F}", "FALSE"));
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  test("a derived measure, a ratio and a filtered sum read the right numbers per member and month", async () => {
    expectMemberMonths(await queryRows(pg.connectionUri, "SELECT * FROM v_memberutilization"));
  });

  test("a money sum is exact, and a divide by a zero or missing budget is NULL", async () => {
    expectProjectBurn(await queryRows(pg.connectionUri, "SELECT * FROM v_projectburn"), true);
  });
});

describe("report arithmetic and money sums, on SQLite", () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(":memory:");
    for (const statement of splitStatements(await schemaSql("sqlite"))) db.run(statement);
    for (const statement of splitStatements(SEED.replaceAll("{T}", "1").replaceAll("{F}", "0"))) db.run(statement);
  });

  afterAll(() => db?.close());

  test("a derived measure, a ratio and a filtered sum read the right numbers per member and month", () => {
    expectMemberMonths(db.query("SELECT * FROM v_memberutilization").all() as Row[]);
  });

  test("a money sum is within a REAL's precision, and a divide by a zero or missing budget is NULL", () => {
    expectProjectBurn(db.query("SELECT * FROM v_projectburn").all() as Row[], false);
  });
});
