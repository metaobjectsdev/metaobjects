/**
 * Bug gate: changing `field.enum @values` NEVER migrated on SQLite. The diff
 * evolved CHECK constraints on postgres only, and on sqlite a check change
 * triggered neither add-check/drop-check nor the recreate-and-copy path — the
 * old comment claiming "SQLite evolves checks via table recreate" was FALSE
 * (nothing triggered that recreate). Adding an enum member therefore reported
 * "No schema changes" while production INSERTs with the new value violated the
 * stale CHECK.
 *
 * Fix under test, all three layers together against a REAL engine:
 *   - sqlite/d1 introspection parses named `CONSTRAINT <n> CHECK (…)` clauses
 *     back out of sqlite_master.sql (they were previously invisible: checks: []),
 *   - the diff evolves checks for the sqlite dialect too,
 *   - the sqlite emitter treats a check change as recreate-and-copy (checks are
 *     create-time-only inline there — there is no ALTER),
 *   - and the re-diff converges to EMPTY afterwards.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

function metaWithStatuses(values: string[]): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Ticket",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": { name: "status", "@values": values, "@required": true } },
              { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        },
      ],
    },
  });
}

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-check-evolution-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "t.db")}` }) });
});
afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function applyRaw(sqlText: string): Promise<void> {
  for (const stmt of sqlText.trim().split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

async function migrate(metaJson: string): Promise<ReturnType<typeof buildExpectedSchema>> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
  const expected = buildExpectedSchema(root, { dialect: "sqlite" });
  const actual = await introspectSqlite(k);
  // allow.dropCheck: evolving a CHECK is a drop+add pair, and drop-check is a
  // gated destructive change (same behavior as the postgres path).
  const result = await diff({ expected, actual, dialect: "sqlite", allow: { dropCheck: true } });
  const { up } = emit(result.changes, {
    dialect: "sqlite",
    expectedSchema: expected,
    ...(actual.meta !== undefined && { actualMeta: actual.meta }),
  });
  await applyRaw(up);
  return expected;
}

describe("SQLite enum @values evolution — real-engine recreate + convergence", () => {
  test("adding an enum member migrates the CHECK; the new value INSERTs; data survives; re-diff empty", async () => {
    // v1: two members. Apply + prove the CHECK is live (bad value rejected).
    await migrate(metaWithStatuses(["OPEN", "CLOSED"]));
    await sql.raw(`INSERT INTO "tickets" ("id", "status") VALUES (1, 'OPEN')`).execute(k);
    await expect(
      sql.raw(`INSERT INTO "tickets" ("id", "status") VALUES (2, 'ARCHIVED')`).execute(k),
    ).rejects.toThrow(/CHECK/i);

    // v2: add a member. THE BUG: the diff said "No schema changes", the stale
    // CHECK stayed, and the production INSERT below kept failing.
    const expected2 = await migrate(metaWithStatuses(["OPEN", "CLOSED", "ARCHIVED"]));

    // The new member is now insertable…
    await sql.raw(`INSERT INTO "tickets" ("id", "status") VALUES (2, 'ARCHIVED')`).execute(k);
    // …a non-member is still rejected (the CHECK was evolved, not dropped)…
    await expect(
      sql.raw(`INSERT INTO "tickets" ("id", "status") VALUES (3, 'BOGUS')`).execute(k),
    ).rejects.toThrow(/CHECK/i);
    // …and the recreate-and-copy preserved the pre-existing row.
    const rows = (await sql.raw(`SELECT "id", "status" FROM "tickets" ORDER BY "id"`).execute(k)).rows;
    expect(rows).toEqual([
      { id: 1, status: "OPEN" },
      { id: 2, status: "ARCHIVED" },
    ]);

    // Idempotence: introspection must read the evolved CHECK back, or every
    // subsequent migrate recreate-and-copies the table again.
    const followup = await diff({
      expected: expected2, actual: await introspectSqlite(k),
      dialect: "sqlite", allow: { dropCheck: true },
    });
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });
});
