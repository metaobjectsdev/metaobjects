/**
 * D3 (real engine, whole CLI pipeline, real SQLite): `meta verify --db` and `meta migrate`
 * reported every managed view over a drifted table as a `- view` / `+ view` pair, even with
 * the view's SQL byte-identical to the metadata's. An adopter could not tell whether any view
 * matched, and neither the text nor `--format json` said what differed.
 *
 * The pair is real migration SQL: SQLite rebuilds a table to change a column's NOT NULL, and
 * that strands the views reading it (#243). But a view recreated only for that reason is not
 * drift. So `verify --db` reports the table change alone, `migrate` still emits the pair and
 * says why, and a view whose definition really differs is reported with what differs.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/index.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function model(opts: { titleRequired: boolean; viewHasTitle?: boolean }): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Program",
            children: [
              { "source.rdb": { name: "src", "@table": "programs" } },
              { "field.long": { name: "id" } },
              { "field.string": { name: "title", ...(opts.titleRequired ? { "@required": true } : {}) } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        },
        {
          "object.projection": {
            name: "ProgramView",
            children: [
              { "source.rdb": { name: "src", "@kind": "view", "@view": "v_programs" } },
              { "field.long": { name: "id", extends: "acme::Program.id" } },
              ...(opts.viewHasTitle === false ? [] : [{ "field.string": { name: "title", extends: "acme::Program.title" } }]),
              { "identity.primary": { name: "pk", extends: "acme::Program.pk" } },
            ],
          },
        },
      ],
    },
  });
}

function writeModel(repo: string, src: string): void {
  writeFileSync(join(repo, "metaobjects", "meta.programs.json"), src, "utf8");
}

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try {
    return { code: await run(argv), stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** A database migrated from the model with `title` nullable, then the model makes it NOT NULL. */
async function driftedRepo(): Promise<{ repo: string; dbUrl: string }> {
  const repo = mkdtempSync(join(tmpdir(), "verify-db-view-recreate-"));
  dirs.push(repo);
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeModel(repo, model({ titleRequired: false }));
  const dbUrl = `file:${join(repo, "local.db")}`;
  const init = await capture([
    "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial", "--apply",
  ]);
  expect(init.code).toBe(0);
  writeModel(repo, model({ titleRequired: true }));
  return { repo, dbUrl };
}

describe("D3 — a view recreated only around a table change", () => {
  test("verify --db reports the table change and not the view", async () => {
    const { repo, dbUrl } = await driftedRepo();
    const { code, stderr } = await capture(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
    expect(code).toBe(1);
    expect(stderr).toContain("~ column programs.title");
    expect(stderr).not.toContain("v_programs");
  });

  test("verify --db --format json carries the difference, and no view row", async () => {
    const { repo, dbUrl } = await driftedRepo();
    const { code, stdout } = await capture([
      "verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--format", "json",
    ]);
    expect(code).toBe(1);
    const payload = JSON.parse(stdout) as {
      schemaDrift: { changes: { kind: string; object: string; detail: string }[]; findings: string[] };
    };
    expect(payload.schemaDrift.changes).toEqual([
      expect.objectContaining({ kind: "change-column-nullable", object: "column" }),
    ]);
  });

  const NOTE =
    "1 view(s) match the metadata and are recreated only because the migration alters a table they read: v_programs";
  const MIGRATE = ["--dialect", "sqlite", "--slug", "title-required", "--allow", "nullable-to-not-null", "--dry-run"];

  // Both planners: the default diffs the metadata against the committed snapshot; --from-db
  // (the adopter's command) diffs it against the live database.
  for (const planner of [[], ["--from-db"]]) {
    const label = planner.length === 0 ? "migrate" : "migrate --from-db";

    test(`${label} still emits the DROP/CREATE VIEW pair, and says the view matches`, async () => {
      const { repo, dbUrl } = await driftedRepo();
      const { code, stdout } = await capture([
        "migrate", "--cwd", repo, ...planner, "--db", dbUrl, ...MIGRATE, "--format", "text",
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain(`DROP VIEW IF EXISTS "v_programs"`);
      expect(stdout).toContain(`CREATE VIEW "v_programs"`);
      expect(stdout).toContain(NOTE);
    });

    test(`${label} --format json carries the same note`, async () => {
      const { repo, dbUrl } = await driftedRepo();
      const { code, stdout } = await capture([
        "migrate", "--cwd", repo, ...planner, "--db", dbUrl, ...MIGRATE, "--format", "json",
      ]);
      expect(code).toBe(0);
      const payload = JSON.parse(stdout) as { notes?: string[]; sql: { up: string } };
      expect(payload.notes).toEqual([NOTE]);
      expect(payload.sql.up).toContain(`CREATE VIEW "v_programs"`);
    });
  }
});

describe("D3 — a view whose definition differs", () => {
  test("verify --db names the view and the first point its text differs", async () => {
    const { repo, dbUrl } = await driftedRepo();
    // The table matches the database again; only the view's columns change.
    writeModel(repo, model({ titleRequired: false, viewHasTitle: false }));
    const { code, stderr } = await capture(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/~ view v_programs \(definition text differs: metadata «.+» vs database «.+»\)/);
    expect(stderr).not.toContain("column programs.title");
  });
});
