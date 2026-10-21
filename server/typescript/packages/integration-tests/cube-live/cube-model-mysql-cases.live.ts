/**
 * The three MySQL corpus cases, EXECUTED on a real MySQL 8.4 through Cube.
 *
 * `fixtures/cube-model/{dimension-time-mysql,measure-mysql,measure-boolean-mysql}` pin the SQL the
 * exporter writes for MySQL where it differs from Postgres: a date as `CAST(… AS DATETIME)`, a
 * tuple distinct count as `COUNT(DISTINCT a, b)` (and with a condition as a `CASE` on the first
 * component), a ratio with no cast, a boolean as `MAX`/`MIN` with `COALESCE(…, 0)`. cube-model.live.ts
 * loads them against its Postgres data source, which proves they COMPILE (a compile runs no SQL);
 * until this file, nothing ran their SQL, only goldens held it.
 *
 * Here each case's generated tree (`fixtures/cube-model/<case>/expected/model`, which
 * `cube-model-corpus.test.ts` holds equal to what the generator writes) is loaded into the pinned
 * Cube over a private MySQL 8.4, the tables the case's model names are created and filled below, and
 * each query is run through Cube.
 *
 * WHY HAND-CHECKED ROWS, NOT A VIEW. The canonical lane (cube-model-mysql.live.ts) compares Cube's
 * rows with `SELECT *` from a report view `buildReportViews` lowers. These cases declare no
 * `object.report`, so there is no view to compare with. The oracle is instead the rows worked out
 * by hand from the seed data below (each expected value carries its derivation), which is
 * independent of the generator and of Cube, and which a wrong spelling of the SQL (a tuple count
 * that counts a `NULL` component, a boolean that comes back as a number, a date bucketed in the
 * wrong zone) cannot satisfy.
 *
 * `*.live.ts`: runs only by its path, from `bun run test:cube`. Without docker every test is
 * SKIPPED behind a banner.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CUBE_IMAGE, CUBE_MYSQL_IMAGE, cubeStackStartBudgetMs, dockerUnavailableReason, startCubeStack, type CubeStack } from "../src/cube-container.ts";
import { type CubeQuery, canonicalDecimal, getMeta, load } from "./cube-live-support.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CORPUS = join(REPO_ROOT, "fixtures", "cube-model");
const TEST_TIMEOUT_MS = 300_000;

/** The tables the three cases' models name (`events`, `weeks`, `calls`), snake_case columns as the cases declare. */
const SCHEMA_AND_SEED = `
CREATE TABLE events (
  id BIGINT NOT NULL PRIMARY KEY,
  occurred_at DATETIME(3) NOT NULL,
  on_date DATE NOT NULL,
  starts_on DATE NOT NULL
);
INSERT INTO events (id, occurred_at, on_date, starts_on) VALUES
  (1, '2026-05-01 08:30:00.000', '2026-05-10', '2026-06-15'),
  (2, '2026-05-01 09:15:00.000', '2026-05-20', '2026-06-15'),
  (3, '2026-05-02 23:59:59.000', '2026-06-03', '2026-07-01'),
  (4, '2026-05-02 00:00:00.000', '2027-01-05', '2026-07-01');

CREATE TABLE weeks (
  id BIGINT NOT NULL PRIMARY KEY,
  program_id BIGINT NOT NULL,
  duration_minutes INT NOT NULL,
  label VARCHAR(50) NULL
);
INSERT INTO weeks (id, program_id, duration_minutes, label) VALUES
  (1, 1, 30, 'a'),
  (2, 1, 60, 'a'),
  (3, 2, 60, 'b'),
  (4, 2, 90, 'c'),
  (5, 3, 90, NULL),
  (6, 3, 30, 'b'),
  (7, 1, 30, 'a');

CREATE TABLE calls (
  id BIGINT NOT NULL PRIMARY KEY,
  failed TINYINT(1) NOT NULL,
  duration_ms INT NOT NULL
);
INSERT INTO calls (id, failed, duration_ms) VALUES
  (1, 0, 50),
  (2, 1, 2000),
  (3, 0, 1500),
  (4, 0, 80);
`;

type Row = Record<string, string | null>;

interface Check {
  readonly name: string;
  readonly query: Omit<CubeQuery, "timezone">;
  /** The rows by hand, keyed by the Cube member as Cube names it in a row; order is not significant. */
  readonly rows: readonly Row[];
}

interface Case {
  readonly name: string;
  /** The cube the case declares (the model is loaded when /v1/meta lists exactly it). */
  readonly cube: string;
  readonly checks: readonly Check[];
}

const q = (parts: Partial<Omit<CubeQuery, "timezone">>): Omit<CubeQuery, "timezone"> => ({
  measures: [], dimensions: [], timeDimensions: [], segments: [], ...parts,
});

const CASES: readonly Case[] = [
  {
    // events: occurred_at (DATETIME), on_date and starts_on (DATE). MySQL's CAST has no TIMESTAMP
    // target, so a date dimension is `CAST(… AS DATETIME)`: a date reads as that day at midnight.
    name: "dimension-time-mysql",
    cube: "Event",
    checks: [
      {
        name: "occurredAt by hour (a DATETIME column, bucketed in UTC)",
        query: q({ timeDimensions: [{ dimension: "Event.occurredAt", granularity: "hour" }] }),
        // 08:30 and 09:15 on May 1 are two hours; 23:59:59 and 00:00:00 on May 2 are two more.
        rows: [
          { "Event.occurredAt.hour": "2026-05-01T08:00:00" },
          { "Event.occurredAt.hour": "2026-05-01T09:00:00" },
          { "Event.occurredAt.hour": "2026-05-02T00:00:00" },
          { "Event.occurredAt.hour": "2026-05-02T23:00:00" },
        ],
      },
      {
        name: "occurredAt by day",
        query: q({ timeDimensions: [{ dimension: "Event.occurredAt", granularity: "day" }] }),
        rows: [{ "Event.occurredAt.day": "2026-05-01T00:00:00" }, { "Event.occurredAt.day": "2026-05-02T00:00:00" }],
      },
      {
        name: "onDate by month (a DATE column, CAST AS DATETIME)",
        query: q({ timeDimensions: [{ dimension: "Event.onDate", granularity: "month" }] }),
        // 2026-05-10 and 2026-05-20 are May; 2026-06-03 is June; 2027-01-05 is January 2027.
        rows: [
          { "Event.onDate.month": "2026-05-01T00:00:00" },
          { "Event.onDate.month": "2026-06-01T00:00:00" },
          { "Event.onDate.month": "2027-01-01T00:00:00" },
        ],
      },
      {
        name: "onDate by year",
        query: q({ timeDimensions: [{ dimension: "Event.onDate", granularity: "year" }] }),
        rows: [{ "Event.onDate.year": "2026-01-01T00:00:00" }, { "Event.onDate.year": "2027-01-01T00:00:00" }],
      },
      {
        name: "startsOn as an attribute dimension (a date is a Cube time member: the day at midnight)",
        query: q({ dimensions: ["Event.startsOn"] }),
        rows: [{ "Event.startsOn": "2026-06-15T00:00:00" }, { "Event.startsOn": "2026-07-01T00:00:00" }],
      },
    ],
  },
  {
    // weeks: 7 rows. program_id/duration pairs: (1,30) (1,60) (2,60) (2,90) (3,90) (3,30) (1,30);
    // labels a a b c NULL b a.
    name: "measure-mysql",
    cube: "Week",
    checks: [
      {
        name: "every measure over all rows",
        query: q({ measures: ["Week.weeks", "Week.labels", "Week.slots", "Week.longSlots", "Week.totalMinutes", "Week.longWeeks", "Week.longShare"] }),
        rows: [
          {
            "Week.weeks": "7", // count(id)
            "Week.labels": "3", // distinct label: a, b, c (the NULL is not counted)
            "Week.slots": "6", // distinct (program, minutes): the repeated (1,30) counts once
            "Week.longSlots": "4", // distinct pairs with minutes >= 60: (1,60) (2,60) (2,90) (3,90); the CASE is NULL for the rest, and COUNT(DISTINCT) skips a NULL component
            "Week.totalMinutes": "390", // 30+60+60+90+90+30+30
            "Week.longWeeks": "4", // rows with minutes >= 60: ids 2, 3, 4, 5
            "Week.longShare": "0.5714", // 4 / 7, MySQL's DECIMAL division
          },
        ],
      },
      {
        name: "the long segment",
        query: q({ measures: ["Week.weeks"], segments: ["Week.long"] }),
        rows: [{ "Week.weeks": "4" }],
      },
      {
        name: "a ratio over an empty scope is NULL, not a division error",
        query: q({
          measures: ["Week.weeks", "Week.longShare"],
          filters: [{ member: "Week.id", operator: "equals", values: ["999"] }],
        }),
        // count is 0; the ratio divides by NULLIF(0, 0), so it is NULL.
        rows: [{ "Week.weeks": "0", "Week.longShare": null }],
      },
    ],
  },
  {
    // calls: (id, failed, duration_ms) = (1,0,50) (2,1,2000) (3,0,1500) (4,0,80). MySQL has no
    // boolean type: Cube hands a boolean measure back as the string "1" or "0".
    name: "measure-boolean-mysql",
    cube: "Call",
    checks: [
      {
        name: "all rows",
        query: q({ measures: ["Call.anyFailed", "Call.allFailed", "Call.anySlowFailed", "Call.anyFastCall", "Call.anyFailedOrFalse", "Call.allFailedOrTrue"] }),
        rows: [
          {
            "Call.anyFailed": "1", // MAX(failed): call 2 failed
            "Call.allFailed": "0", // MIN(failed): the others did not
            "Call.anySlowFailed": "1", // calls over 1000 ms are 2 (failed) and 3 (not): MAX = 1
            "Call.anyFastCall": "1", // calls 1 and 4 are under 100 ms
            "Call.anyFailedOrFalse": "1",
            "Call.allFailedOrTrue": "0",
          },
        ],
      },
      {
        name: "call 1 (fast, not failed): a condition that selects no row is NULL, a default fills it",
        query: q({
          measures: ["Call.anyFailed", "Call.allFailed", "Call.anySlowFailed", "Call.anyFastCall", "Call.anyFailedOrFalse", "Call.allFailedOrTrue"],
          filters: [{ member: "Call.id", operator: "equals", values: ["1"] }],
        }),
        rows: [
          {
            "Call.anyFailed": "0",
            "Call.allFailed": "0",
            "Call.anySlowFailed": null, // 50 ms is not slow: MAX(CASE … END) over no matching value is NULL
            "Call.anyFastCall": "1",
            "Call.anyFailedOrFalse": "0",
            "Call.allFailedOrTrue": "0",
          },
        ],
      },
      {
        name: "call 3 (slow, not failed)",
        query: q({
          measures: ["Call.anySlowFailed", "Call.anyFastCall"],
          filters: [{ member: "Call.id", operator: "equals", values: ["3"] }],
        }),
        // 1500 ms is slow, so the CASE yields failed (0); not fast, so COALESCE(0 < ..., 0) is 0.
        rows: [{ "Call.anySlowFailed": "0", "Call.anyFastCall": "0" }],
      },
      {
        name: "no rows at all: the aggregates are NULL and the @default measures are their defaults",
        query: q({
          measures: ["Call.anyFailed", "Call.allFailed", "Call.anyFailedOrFalse", "Call.allFailedOrTrue"],
          filters: [{ member: "Call.id", operator: "equals", values: ["999"] }],
        }),
        rows: [{ "Call.anyFailed": null, "Call.allFailed": null, "Call.anyFailedOrFalse": "0", "Call.allFailedOrTrue": "1" }],
      },
    ],
  },
];

const unavailable = dockerUnavailableReason();
if (unavailable !== undefined) {
  const bar = "!".repeat(78);
  console.warn(
    `\n${bar}\n!! CUBE MYSQL CASES LIVE CHECK SKIPPED: docker unavailable (${unavailable})\n` +
      `!! Nothing was checked against ${CUBE_IMAGE} on ${CUBE_MYSQL_IMAGE}. Every test in this file reports SKIP.\n${bar}\n`,
  );
}
const skip = unavailable !== undefined;

let work = "";
let mount = "";
let stack: CubeStack | undefined;
const timings: string[] = [];

beforeAll(async () => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), "mo-cube-mysql-cases-"));
  process.on("exit", cleanUp);
  try {
    mount = join(work, "model");
    mkdirSync(mount);
    // Cube needs a model directory to start; the first case's tree is in it until a test swaps it.
    cpSync(caseModel(CASES[0]!.name), mount, { recursive: true });
    const t0 = Date.now();
    const started = await startCubeStack(mount, { dataSource: "mysql", initSql: [SCHEMA_AND_SEED] });
    if (started.kind === "skipped") throw new Error(`docker answered a moment ago and no longer does: ${started.reason}`);
    stack = started.stack;
    timings.push(`stack up (MySQL + case tables, Cube /meta): ${Date.now() - t0} ms`);
  } catch (e) {
    cleanUp();
    throw e;
  }
}, cubeStackStartBudgetMs() + 120_000);

afterAll(() => {
  cleanUp();
  process.off("exit", cleanUp);
  if (timings.length > 0) console.log(`cube mysql cases timings:\n  ${timings.join("\n  ")}`);
}, 180_000);

function cleanUp(): void {
  stack?.stop();
  stack = undefined;
  if (work !== "") rmSync(work, { recursive: true, force: true });
  work = "";
}

function caseModel(name: string): string {
  const dir = join(CORPUS, name, "expected", "model");
  if (!existsSync(dir)) throw new Error(`corpus case '${name}' has no expected/model tree`);
  return dir;
}

/** Every cube a case's tree declares, by name. */
function declaredCubeNames(dir: string): string[] {
  const names: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".yml")) {
        const doc = YAML.parse(readFileSync(full, "utf8")) as { cubes?: { name?: unknown }[] };
        for (const c of doc.cubes ?? []) names.push(String(c.name));
      }
    }
  };
  walk(dir);
  return names.sort();
}

let swaps = 0;

/** Replace the mounted model with a case's tree and wait until Cube lists exactly that case's cubes. */
async function loadCase(s: CubeStack, name: string): Promise<void> {
  const n = swaps++;
  for (const entry of readdirSync(mount)) renameSync(join(mount, entry), join(work, `retired-${n}-${entry}`));
  const stage = join(work, `stage-${n}`);
  cpSync(caseModel(name), stage, { recursive: true });
  for (const entry of readdirSync(stage)) renameSync(join(stage, entry), join(mount, entry));
  const want = declaredCubeNames(caseModel(name));
  const deadline = Date.now() + 120_000;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const meta = await getMeta(s, 30_000);
      last = meta.error ?? meta.cubes.map((c) => c.name).sort().join(", ");
      if (meta.error === undefined && Bun.deepEquals(meta.cubes.map((c) => c.name).sort(), want)) return;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(500);
  }
  throw new Error(`Cube did not list [${want.join(", ")}] for case '${name}' within 120s (last /meta: ${last})`);
}

/** A Cube value as comparable text: a time to the second, a number to four decimals (a ratio is DECIMAL(…,4)), a flag as it is. */
function normal(key: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 19);
  if (/^-?\d+(\.\d+)?$/.test(s)) return /\./.test(s) && !/^-?\d+\.0+$/.test(s) ? Number(s).toFixed(4) : canonicalDecimal(s);
  throw new Error(`${key}: unexpected value ${JSON.stringify(v)}`);
}

function sorted(rows: readonly Row[]): Row[] {
  return rows.slice().sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

describe(`cube-model MySQL corpus cases, executed (${CUBE_IMAGE} over ${CUBE_MYSQL_IMAGE})`, () => {
  test.skipIf(skip)("the cases below are exactly the corpus's MySQL cases", () => {
    const mysqlCases = readdirSync(CORPUS)
      .filter((d) => existsSync(join(CORPUS, d, "case.json")) && existsSync(join(CORPUS, d, "expected")))
      .filter((d) => (JSON.parse(readFileSync(join(CORPUS, d, "case.json"), "utf8")) as { dialect?: string }).dialect === "mysql")
      .sort();
    expect(mysqlCases).toEqual(CASES.map((c) => c.name).sort());
  });

  for (const c of CASES) {
    describe(c.name, () => {
      test.skipIf(skip)("Cube compiles the case's tree over MySQL", async () => {
        if (stack === undefined) throw new Error("the cube stack did not start (see beforeAll)");
        await loadCase(stack, c.name);
      }, TEST_TIMEOUT_MS);

      for (const check of c.checks) {
        test.skipIf(skip)(`${check.name}: the rows Cube runs on MySQL are the hand-checked ones`, async () => {
          if (stack === undefined) throw new Error("the cube stack did not start (see beforeAll)");
          const result = await load(stack, { ...check.query, timezone: "UTC" });
          const wantKeys = new Set(check.rows.flatMap((r) => Object.keys(r)));
          const got = sorted(
            result.data.map((row) => {
              const out: Row = {};
              for (const k of wantKeys) {
                if (!(k in row)) throw new Error(`Cube's row has no '${k}': ${JSON.stringify(row)}`);
                out[k] = normal(k, row[k]);
              }
              return out;
            }),
          );
          const want = sorted(check.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : normal(k, v)]))));
          expect(got).toEqual(want);
        }, TEST_TIMEOUT_MS);
      }
    });
  }
});
