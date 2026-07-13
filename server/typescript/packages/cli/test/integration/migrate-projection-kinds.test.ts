/**
 * Bug gate (real engine, whole CLI pipeline): `meta migrate` CRASHED OUTRIGHT
 * for any model containing an FR-015 stored-proc projection — the CLI calls
 * buildProjectionViews unconditionally, and extractViewSpec throws for a
 * base-less proc projection ("cannot derive the base entity"). A
 * materializedView projection silently created a PLAIN view instead.
 *
 * After the fix: proc/tableFunction/matview projections are skipped by the view
 * pipeline (procs are callables, not views; matviews are hand-managed — the
 * pipeline has no CREATE MATERIALIZED VIEW and PG introspection cannot see
 * matviews, so managing them could never converge). The plain-view projection
 * still migrates, applies against a REAL sqlite db, and a re-run is a no-op.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": { name: "src", "@table": "programs" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "title", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      // Plain-view projection — the migrate pipeline manages this one.
      {
        "object.projection": {
          name: "ProgramView",
          children: [
            { "source.rdb": { name: "src", "@kind": "view", "@view": "v_programs" } },
            { "field.long": { name: "id", extends: "acme::Program.id" } },
            { "field.string": { name: "title", extends: "acme::Program.title" } },
            { "identity.primary": { name: "pk", extends: "acme::Program.pk" } },
          ],
        },
      },
      // FR-015 proc projection — previously crashed the whole migrate command.
      {
        "object.value": {
          name: "PhaseArgs",
          children: [{ "field.int": { name: "caseId", "@required": true } }],
        },
      },
      {
        "object.projection": {
          name: "PhaseSummary",
          children: [
            {
              "source.rdb": {
                name: "src", "@kind": "storedProc",
                "@proc": "fn_phase_summary", "@parameterRef": "PhaseArgs",
              },
            },
            { "field.long": { name: "phaseId" } },
          ],
        },
      },
      // STANDALONE read-model: a plain-view projection that declares its own columns and
      // anchors NOTHING (no extends, no origin.*). Its SQL is hand-authored — the
      // documented custom-SQL-view exception. THE BUG: this threw "cannot derive the base
      // entity" inside buildProjectionViews, which the CLI calls unconditionally, so ONE
      // such view aborted `meta migrate` for the ENTIRE model — Program included. An
      // adopter with a couple of hand-written monitoring views could not run migrate at all.
      {
        "object.projection": {
          name: "SessionHealth",
          children: [
            { "source.rdb": { name: "src", "@kind": "view", "@view": "v_session_health" } },
            { "field.long": { name: "sessionId" } },
            { "field.boolean": { name: "hasError" } },
          ],
        },
      },
      // Matview projection — hand-managed; must not become a plain VIEW.
      {
        "object.projection": {
          name: "ProgramStats",
          children: [
            {
              "source.rdb": {
                name: "src", "@kind": "materializedView",
                "@materializedView": "mv_program_stats",
              },
            },
            { "field.long": { name: "id", extends: "acme::Program.id" } },
            { "identity.primary": { name: "pk", extends: "acme::Program.pk" } },
          ],
        },
      },
    ],
  },
});

function setupRepo(): { repo: string; dbUrl: string } {
  const repo = mkdtempSync(join(tmpdir(), "migrate-projection-kinds-"));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeFileSync(join(repo, "metaobjects", "meta.programs.json"), META, "utf8");
  return { repo, dbUrl: `file:${join(repo, "local.db")}` };
}

describe("meta migrate — proc/matview projection kinds (real sqlite)", () => {
  test("migrate --apply succeeds, creates the plain view only, and a re-run is a no-op", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      // THE BUG: this crashed before reaching the diff at all.
      const exit = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial", "--apply",
      ]);
      expect(exit).toBe(0);

      const client = createClient({ url: dbUrl });
      const objects = await client.execute(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view')",
      );
      client.close();
      const byName = new Map(objects.rows.map((r) => [String(r.name), String(r.type)]));
      expect(byName.get("programs")).toBe("table");
      // The plain-view projection IS managed…
      expect(byName.get("v_programs")).toBe("view");
      // …the matview is NOT silently created as a plain view, and the proc emits nothing.
      expect(byName.has("mv_program_stats")).toBe(false);
      expect([...byName.keys()].some((n) => n.includes("fn_phase_summary"))).toBe(false);
      // …and the STANDALONE read-model is left alone: hand-authored SQL, so migrate
      // neither creates nor drops it. The load-bearing assertion is `exit === 0` and
      // `programs` existing above — before the fix, this projection aborted the entire
      // command and NOTHING was migrated.
      expect(byName.has("v_session_health")).toBe(false);

      // Idempotence: a second run writes no new migration.
      const migrationsRoot = join(repo, ".metaobjects", "migrations");
      const before = readdirSync(migrationsRoot).length;
      const exit2 = await run(["migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--apply"]);
      expect(exit2).toBe(0);
      expect(readdirSync(migrationsRoot).length).toBe(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);
});
