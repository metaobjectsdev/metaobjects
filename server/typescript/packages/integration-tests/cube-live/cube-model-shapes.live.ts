/**
 * The shapes the other Cube lane files only COMPILE, EXECUTED on Postgres through Cube.
 *
 * `cube-model.live.ts` loads every corpus case that has an expected tree, and Cube accepts it, but
 * a compile runs no SQL. Five shapes had no live query crossing them (docs/features/cube-export.md
 * used to list them under "Known limits"):
 *
 *   join-alias-cubes        two alias cubes onto one table (`Match_homeRef`, `Match_awayRef` over `teams`)
 *   entity-tph-subtype      a TPH subtype's cube whose `sql` is `SELECT * FROM … WHERE "type" = 'Bridge'`
 *   join-one-to-one         a `one_to_one` join and its `many_to_one` mirror, read from either end
 *   dimension-int-enum      an int-backed enum's `CASE … WHEN 1 THEN 'LOW' …` dimension
 *   report-spine-multi-hop  a `@spine` report through two hops (`Session.fkWeek.fkProgram`), whose
 *                           Cube view must give the rows of the SQL view `buildReportViews` lowers,
 *                           spine rows with no facts included
 *
 * For each, the case's generated tree (`fixtures/cube-model/<case>/expected/model`, which
 * `cube-model-corpus.test.ts` holds equal to what the generator writes) is loaded into the pinned
 * Cube over a private Postgres 16 holding the tables below, and every query is run through Cube and
 * compared with the rows an independent SQL statement returns from the same database. The spine
 * case's oracle is the lowered report view, as in the canonical lane; the others have no
 * `object.report`, so their oracle is a plain `SELECT` written here, which neither the generator
 * nor Cube produced.
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
import { buildReportViews } from "@metaobjectsdev/codegen-ts";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { CUBE_IMAGE, cubeStackStartBudgetMs, dockerUnavailableReason, startCubeStack, type CubeStack } from "../src/cube-container.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { type CubeQuery, cubeQueryFor, fromCubeRow, fromViewRow, getMeta, load, selectSqlPg, selectViewPg, sortRows } from "./cube-live-support.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CORPUS = join(REPO_ROOT, "fixtures", "cube-model");
const TEST_TIMEOUT_MS = 300_000;

const SPINE_CASE = "report-spine-multi-hop";
const SPINE_REPORT = "ProgramSessions";

/** Every table the five cases' models name, snake_case columns as the cases declare. */
const SCHEMA_AND_SEED = `
CREATE TABLE teams (id BIGINT PRIMARY KEY, name TEXT);
INSERT INTO teams (id, name) VALUES (1, 'Reds'), (2, 'Blues'), (3, 'Greens');
CREATE TABLE matches (id BIGINT PRIMARY KEY, home_team_id BIGINT, away_team_id BIGINT);
INSERT INTO matches (id, home_team_id, away_team_id) VALUES
  (1, 1, 2), (2, 1, 2), (3, 2, 1), (4, 3, 1), (5, 3, 2);

CREATE TABLE auths (id BIGINT PRIMARY KEY, type TEXT NOT NULL);
INSERT INTO auths (id, type) VALUES (1, 'Bridge'), (2, 'Copay'), (3, 'Bridge'), (4, 'Copay'), (5, 'Copay'), (6, 'Bridge'), (7, 'Bridge');

-- programs: 1 and 3 have a profile, 2 has none; program 4 has sessions through no week (spine row, no facts).
CREATE TABLE programs (id BIGINT PRIMARY KEY, title TEXT);
INSERT INTO programs (id, title) VALUES (1, 'Alpha'), (2, 'Beta'), (3, 'Gamma'), (4, 'Delta');
CREATE TABLE profiles (id BIGINT PRIMARY KEY, program_id BIGINT);
INSERT INTO profiles (id, program_id) VALUES (10, 1), (11, 3);

CREATE TABLE tickets (id BIGINT PRIMARY KEY, priority INT NOT NULL);
INSERT INTO tickets (id, priority) VALUES (1, 1), (2, 2), (3, 2), (4, 1), (5, 2);

-- weeks 1,2 belong to Alpha; 3 to Beta; 4 to Gamma (all of Gamma's sessions are under 10 minutes).
CREATE TABLE weeks (id BIGINT PRIMARY KEY, program_id BIGINT NOT NULL);
INSERT INTO weeks (id, program_id) VALUES (1, 1), (2, 1), (3, 2), (4, 3);
CREATE TABLE sessions (id BIGINT PRIMARY KEY, week_id BIGINT NOT NULL, minutes INT);
INSERT INTO sessions (id, week_id, minutes) VALUES
  (1, 1, 30), (2, 1, 45), (3, 2, 10), (4, 2, 5), (5, 3, 60), (6, 4, 9), (7, 4, 2);
`;

type Row = Record<string, string | null>;

interface Check {
  readonly name: string;
  readonly query: Omit<CubeQuery, "timezone">;
  /** A SELECT whose columns are aliased to the Cube row keys the query returns. */
  readonly oracle: string;
  /** Rows the oracle must return (non-vacuity): a count, so a query that returned nothing cannot pass. */
  readonly rows: number;
}

interface Case {
  readonly name: string;
  readonly cubes: readonly string[];
  readonly checks: readonly Check[];
}

const q = (parts: Partial<Omit<CubeQuery, "timezone">>): Omit<CubeQuery, "timezone"> => ({
  measures: [], dimensions: [], timeDimensions: [], segments: [], ...parts,
});

const CASES: readonly Case[] = [
  {
    name: "join-alias-cubes",
    cubes: ["Match", "Match_awayRef", "Match_homeRef"],
    checks: [
      {
        name: "matches by the home team's name (the Match_homeRef alias)",
        query: q({ measures: ["Match.matches"], dimensions: ["Match.homeName"] }),
        oracle: `SELECT t.name AS "Match.homeName", count(m.id) AS "Match.matches" FROM matches m LEFT JOIN teams t ON m.home_team_id = t.id GROUP BY t.name`,
        rows: 3,
      },
      {
        name: "matches by the away team's name (the Match_awayRef alias)",
        query: q({ measures: ["Match.matches"], dimensions: ["Match.awayName"] }),
        oracle: `SELECT t.name AS "Match.awayName", count(m.id) AS "Match.matches" FROM matches m LEFT JOIN teams t ON m.away_team_id = t.id GROUP BY t.name`,
        rows: 2,
      },
      {
        name: "both aliases in one query: each fixture is counted under its own home and away pair",
        query: q({ measures: ["Match.matches"], dimensions: ["Match.homeName", "Match.awayName"] }),
        oracle:
          `SELECT h.name AS "Match.homeName", a.name AS "Match.awayName", count(m.id) AS "Match.matches" FROM matches m ` +
          `LEFT JOIN teams h ON m.home_team_id = h.id LEFT JOIN teams a ON m.away_team_id = a.id GROUP BY h.name, a.name`,
        rows: 4,
      },
    ],
  },
  {
    name: "entity-tph-subtype",
    cubes: ["BridgeAuth"],
    checks: [
      {
        name: "the subtype's measure counts only its discriminator's rows",
        query: q({ measures: ["BridgeAuth.bridges"] }),
        oracle: `SELECT count(id) AS "BridgeAuth.bridges" FROM auths WHERE type = 'Bridge'`,
        rows: 1,
      },
      {
        name: "the subtype's rows are only the Bridge rows",
        query: q({ dimensions: ["BridgeAuth.id"] }),
        oracle: `SELECT id AS "BridgeAuth.id" FROM auths WHERE type = 'Bridge'`,
        rows: 4,
      },
    ],
  },
  {
    name: "join-one-to-one",
    cubes: ["Profile", "Program"],
    checks: [
      {
        name: "Program.programs and Profile.profiles side by side across the one_to_one join",
        query: q({ measures: ["Program.programs", "Profile.profiles"] }),
        oracle: `SELECT count(p.id) AS "Program.programs", count(pr.id) AS "Profile.profiles" FROM programs p LEFT JOIN profiles pr ON pr.program_id = p.id`,
        rows: 1,
      },
      {
        name: "profiles per program, read from the one_to_one end (a program with no profile reads 0)",
        query: q({ measures: ["Profile.profiles"], dimensions: ["Program.id"] }),
        oracle: `SELECT p.id AS "Program.id", count(pr.id) AS "Profile.profiles" FROM programs p LEFT JOIN profiles pr ON pr.program_id = p.id GROUP BY p.id`,
        rows: 4,
      },
      {
        name: "programs per profile, read from the many_to_one end",
        query: q({ measures: ["Program.programs"], dimensions: ["Profile.id"] }),
        oracle: `SELECT pr.id AS "Profile.id", count(p.id) AS "Program.programs" FROM profiles pr LEFT JOIN programs p ON pr.program_id = p.id GROUP BY pr.id`,
        rows: 2,
      },
    ],
  },
  {
    name: "dimension-int-enum",
    cubes: ["Ticket"],
    checks: [
      {
        name: "the int-backed enum reads as its member symbol",
        query: q({ dimensions: ["Ticket.priority"] }),
        // Independent of the exporter's CASE: the stored integers mapped by the model's @intValueMap.
        oracle: `SELECT DISTINCT CASE WHEN priority = 1 THEN 'LOW' WHEN priority = 2 THEN 'HIGH' END AS "Ticket.priority" FROM tickets`,
        rows: 2,
      },
      {
        name: "a filter on the symbol selects the rows of its integer",
        query: q({ dimensions: ["Ticket.id"], filters: [{ member: "Ticket.priority", operator: "equals", values: ["HIGH"] }] }),
        oracle: `SELECT id AS "Ticket.id" FROM tickets WHERE priority = 2`,
        rows: 3,
      },
    ],
  },
];

const unavailable = dockerUnavailableReason();
if (unavailable !== undefined) {
  const bar = "!".repeat(78);
  console.warn(
    `\n${bar}\n!! CUBE SHAPES LIVE CHECK SKIPPED: docker unavailable (${unavailable})\n` +
      `!! Nothing was checked against ${CUBE_IMAGE}. Every test in this file reports SKIP.\n${bar}\n`,
  );
}
const skip = unavailable !== undefined;

let work = "";
let mount = "";
let stack: CubeStack | undefined;
let spineRoot: MetaRoot | undefined;
const timings: string[] = [];

function caseModel(name: string): string {
  const dir = join(CORPUS, name, "expected", "model");
  if (!existsSync(dir)) throw new Error(`corpus case '${name}' has no expected/model tree`);
  return dir;
}

beforeAll(async () => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), "mo-cube-shapes-"));
  process.on("exit", cleanUp);
  try {
    mount = join(work, "model");
    mkdirSync(mount);
    cpSync(caseModel(CASES[0]!.name), mount, { recursive: true });

    // The spine case's oracle is the view the report lowers to.
    spineRoot = await loadMetadataFile(join(CORPUS, SPINE_CASE, "meta.json"));
    const views = buildReportViews(spineRoot, { dialect: "postgres" });
    const viewSql = views.map((v) => `CREATE VIEW "${v.name}" AS ${v.sql};`).join("\n");

    const t0 = Date.now();
    const started = await startCubeStack(mount, { initSql: [SCHEMA_AND_SEED, viewSql] });
    if (started.kind === "skipped") throw new Error(`docker answered a moment ago and no longer does: ${started.reason}`);
    stack = started.stack;
    timings.push(`stack up (Postgres + shape tables, Cube /meta): ${Date.now() - t0} ms`);
  } catch (e) {
    cleanUp();
    throw e;
  }
}, cubeStackStartBudgetMs() + 120_000);

afterAll(() => {
  cleanUp();
  process.off("exit", cleanUp);
  if (timings.length > 0) console.log(`cube shapes timings:\n  ${timings.join("\n  ")}`);
}, 180_000);

function cleanUp(): void {
  stack?.stop();
  stack = undefined;
  if (work !== "") rmSync(work, { recursive: true, force: true });
  work = "";
}

function requireStack(): CubeStack {
  if (stack === undefined) throw new Error("the cube stack did not start (see beforeAll)");
  return stack;
}

function declaredCubeNames(dir: string): string[] {
  const names: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".yml")) {
        const doc = YAML.parse(readFileSync(full, "utf8")) as { cubes?: { name?: unknown }[]; views?: { name?: unknown }[] };
        for (const c of [...(doc.cubes ?? []), ...(doc.views ?? [])]) names.push(String(c.name));
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

function sorted(rows: readonly Row[]): Row[] {
  return rows.slice().sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

describe(`cube-model shapes, executed (${CUBE_IMAGE} over Postgres)`, () => {
  for (const c of CASES) {
    describe(c.name, () => {
      test.skipIf(skip)("Cube lists exactly the cubes the case's tree declares", async () => {
        const s = requireStack();
        await loadCase(s, c.name);
        const meta = await getMeta(s);
        expect(meta.cubes.map((x) => x.name).sort()).toEqual([...c.cubes]);
      }, TEST_TIMEOUT_MS);

      for (const check of c.checks) {
        test.skipIf(skip)(`${check.name}: the rows Cube runs are the rows plain SQL returns`, async () => {
          const s = requireStack();
          const want = sorted(selectSqlPg(s, check.oracle));
          expect(want.length).toBe(check.rows);
          const result = await load(s, { ...check.query, timezone: "UTC" });
          const keys = Object.keys(want[0] ?? {});
          const got = sorted(
            result.data.map((row) => {
              const out: Row = {};
              for (const k of keys) {
                if (!(k in row)) throw new Error(`Cube's row has no '${k}': ${JSON.stringify(row)}`);
                const v = row[k];
                out[k] = v === null || v === undefined ? null : String(v);
              }
              return out;
            }),
          );
          expect(got).toEqual(want);
        }, TEST_TIMEOUT_MS);
      }
    });
  }

  describe(SPINE_CASE, () => {
    test.skipIf(skip)("the two-hop @spine Cube view answers the rows of the SQL view, spine rows with no facts included", async () => {
      const s = requireStack();
      await loadCase(s, SPINE_CASE);
      const root = spineRoot;
      if (root === undefined) throw new Error("the spine model did not load (see beforeAll)");
      const report = root.objects().find((o) => o.name === SPINE_REPORT);
      if (report === undefined) throw new Error(`${SPINE_REPORT} is not in the case's model`);
      const plan = cubeQueryFor(report, root);
      const result = await load(s, plan.query);
      const cubeRows = sortRows(result.data.map((row) => fromCubeRow(row, plan, "postgres")), plan);
      // This case declares no physical naming, so the view's columns are snake_case (`program_key`);
      // the plan names report fields (`programKey`).
      const camel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      const viewRows = sortRows(
        selectViewPg(s, "v_program_sessions").map((row) =>
          fromViewRow(Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])), plan, "v_program_sessions"),
        ),
        plan,
      );
      // Non-vacuity: all four programs are spine rows, and Delta (no weeks) and Gamma (only
      // sessions under the report's 10-minute filter) are the ones with no facts.
      expect(viewRows.length).toBe(4);
      expect(viewRows.filter((r) => r.sessions === "0").length).toBe(2);
      expect(cubeRows).toEqual(viewRows);
    }, TEST_TIMEOUT_MS);
  });
});
