// migration-scenario.ts — execute a MigrationScenario end-to-end against a
// fresh Postgres testcontainer. Mirrors the C# MigrationScenarioRunner.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExpectedSchema, diff, emit, introspectPostgres } from "@metaobjectsdev/migrate-ts";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { loadMetadataDir } from "./load-metadata.ts";
import { canonicalJson, normalizeRow } from "./normalization.ts";
import { executeSql, queryRows } from "./postgres-sql.ts";
import type { MigrationScenario } from "./scenario.ts";

export async function runMigrationScenario(scenario: MigrationScenario, connectionUri: string): Promise<void> {
  // 1. Bootstrap the starting schema, if any.
  if (scenario.seedMetadataDir) {
    const seedSql = await buildFullCreate(scenario.seedMetadataDir);
    await executeSql(connectionUri, seedSql);
  }
  // 2. Seed data.
  if (scenario.seedData && scenario.seedData.trim().length > 0)
    await executeSql(connectionUri, scenario.seedData);

  // 3. Run the incremental migration against the target.
  const targetDir = resolveTargetMetadata(scenario);
  const targetRoot = await loadMetadataDir(targetDir);
  // The cross-port corpus is authored with field names = column names verbatim
  // (it mirrors the C# adopter's EF schema). Pin "literal" so both ports produce
  // the same physical schema from the same fixture; without this TS would
  // snake_case `programId` → `program_id` and the bootstrap up-SQL assertion
  // for `weeks_programId_fk` would never match.
  const expected = buildExpectedSchema(targetRoot, { columnNamingStrategy: "literal" });

  // Kysely owns its pool exclusively — calling pool.end() ourselves on a pool
  // shared with kysely produces a "Called end on pool more than once" hang.
  const kysely = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: connectionUri }) }),
  });
  try {
    const actual = await introspectPostgres(kysely);
    const result = await diff({ expected, actual });

    const emittable = result.changes.filter((c) => c.status.state !== "blocked");
    const emitted = emittable.length === 0
      ? { up: "", down: "" }
      : emit(emittable, { dialect: "postgres" });

    // 4. Assertions.
    assertBlocked(scenario, result.blocked);
    assertUpContains(scenario, emitted.up);
    assertUpEmpty(scenario, emitted.up);

    // 5. Apply + post-query.
    if (
      scenario.expect.applyUpThenQuery &&
      result.blocked.length === 0 &&
      emitted.up.trim().length > 0
    ) {
      await executeSql(connectionUri, emitted.up);
      const actualRows = await queryRows(connectionUri, scenario.expect.applyUpThenQuery.sql);
      assertRows(scenario.sourcePath, "apply-up-then-query", scenario.expect.applyUpThenQuery.rows, actualRows);
    }
  } finally {
    await kysely.destroy();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildFullCreate(metadataDir: string): Promise<string> {
  const root = await loadMetadataDir(metadataDir);
  const expected = buildExpectedSchema(root, { columnNamingStrategy: "literal" });
  const result = await diff({ expected, actual: { tables: [], views: [] } });
  return emit(result.changes, { dialect: "postgres" }).up;
}

function resolveTargetMetadata(s: MigrationScenario): string {
  if (s.targetMetadataDir) return s.targetMetadataDir;
  if (s.targetMetadataInline !== null) {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-scenario-"));
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "meta.json"), s.targetMetadataInline);
    return tmp;
  }
  throw new Error(`${s.sourcePath}: missing target-metadata / target-metadata-inline`);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertBlocked(s: MigrationScenario, actualBlocked: ReadonlyArray<unknown>): void {
  if (s.expect.blocked.length === 0) {
    if (actualBlocked.length > 0)
      throw new Error(
        `${s.sourcePath}: expected no blocked changes; got ${actualBlocked.length}: ${JSON.stringify(actualBlocked)}`,
      );
    return;
  }
  const formatted = actualBlocked.map(formatBlockedChange);
  for (const want of s.expect.blocked) {
    const hit = formatted.some((b) => b.startsWith(want.kind) && b.includes(want.reasonContains));
    if (!hit)
      throw new Error(
        `${s.sourcePath}: expected blocked '${want.kind}' with reason containing '${want.reasonContains}'; got: ${formatted.join(
          "; ",
        )}`,
      );
  }
}

function formatBlockedChange(c: unknown): string {
  const obj = c as { kind?: string; status?: { blockedReason?: string } };
  // TS change kinds are kebab-case ("drop-table"); the C# format uses PascalCase
  // ("DropTable"). Normalize to PascalCase for the cross-port-shared "kind"
  // assertion vocabulary so both runners agree on what `kind: DropTable` means.
  const kebab = obj.kind ?? "?";
  const pascal = kebab.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return `${pascal}: ${obj.status?.blockedReason ?? ""}`;
}

function assertUpContains(s: MigrationScenario, up: string): void {
  for (const needle of s.expect.upContains) {
    if (!up.includes(needle))
      throw new Error(`${s.sourcePath}: up SQL did not contain '${needle}'.\n--- up SQL ---\n${up}`);
  }
}

function assertUpEmpty(s: MigrationScenario, up: string): void {
  if (s.expect.upEmpty !== true) return;
  if (up.trim().length > 0)
    throw new Error(`${s.sourcePath}: expected up-empty: true but got non-empty SQL:\n${up}`);
}

function assertRows(
  scenarioPath: string,
  queryName: string,
  expected: ReadonlyArray<Record<string, unknown>>,
  actual: ReadonlyArray<Record<string, unknown>>,
): void {
  const expectedJson = canonicalJson(expected.map(normalizeRow));
  const actualJson = canonicalJson(actual.map(normalizeRow));
  if (expectedJson !== actualJson)
    throw new Error(
      `${scenarioPath} / ${queryName}: row mismatch\n  expected: ${expectedJson}\n  actual:   ${actualJson}`,
    );
}
