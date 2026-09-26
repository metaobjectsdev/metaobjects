/**
 * Bug gate: `validator.requiredWhen` / `presentIff` derived a CHECK spelled
 * `IS [NOT] DISTINCT FROM` on SQLite too. SQLite parses that only from 3.39.0, and
 * `sqlite_master` is parsed when a database is OPENED — so on an older engine (Ubuntu
 * 22.04's sqlite3 3.37.2, the stdlib `sqlite3` of its Python) the whole database failed
 * to open: `malformed database schema (talks) - near "DISTINCT"`.
 *
 * Under test, against a real engine:
 *   - a fresh sqlite migration carries no `DISTINCT FROM`, applies, and re-diffs EMPTY;
 *   - a database created BEFORE the fix (legacy spelling) is migrated ONCE to the new
 *     spelling, without `allow.dropCheck` (same rule, nothing lost) and without a data
 *     hazard, the rule still holds afterwards, and the re-diff is EMPTY (no perpetual drift);
 *   - when an old `sqlite3` CLI (< 3.39) is on PATH, it opens the migrated database.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [{
      "object.entity": {
        name: "Talk",
        children: [
          { "source.rdb": { "@table": "talks" } },
          { "field.long": { name: "id" } },
          { "field.enum": { name: "status", "@values": ["DRAFT", "ACCEPTED"], "@required": true } },
          { "field.string": { name: "slot" } },
          { "field.boolean": { name: "is_used" } },
          { "field.timestamp": { name: "used_at" } },
          { "validator.requiredWhen": { name: "slotWhenAccepted", "@field": "slot", "@when": "status", "@equals": "ACCEPTED" } },
          { "validator.presentIff": { name: "used", "@field": "used_at", "@when": "is_used", "@equals": "true" } },
          { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

let tmpDir: string;
let dbFile: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-null-safe-floor-"));
  dbFile = join(tmpDir, "t.db");
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${dbFile}` }) });
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

async function expected(): Promise<ReturnType<typeof buildExpectedSchema>> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
  return buildExpectedSchema(root, { dialect: "sqlite" });
}

async function migrateOnce(): Promise<Awaited<ReturnType<typeof diff>>> {
  const exp = await expected();
  const actual = await introspectSqlite(k);
  const result = await diff({ expected: exp, actual, dialect: "sqlite" });
  const { up } = emit(result.changes, {
    dialect: "sqlite", expectedSchema: exp,
    ...(actual.meta !== undefined && { actualMeta: actual.meta }),
  });
  await applyRaw(up);
  return result;
}

async function rediff(): Promise<unknown[]> {
  return (await diff({ expected: await expected(), actual: await introspectSqlite(k), dialect: "sqlite" })).changes;
}

/** An old `sqlite3` CLI on PATH, when the machine has one (Ubuntu 22.04 ships 3.37.2). */
function oldSqliteCli(): boolean {
  const r = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const m = /^3\.(\d+)\./.exec(r.stdout.trim());
  return m !== null && Number(m[1]) < 39;
}

async function assertRuleHolds(): Promise<void> {
  await sql.raw(`INSERT INTO "talks" ("id", "status") VALUES (1, 'DRAFT')`).execute(k);
  await sql.raw(`INSERT INTO "talks" ("id", "status", "slot") VALUES (2, 'ACCEPTED', 'A1')`).execute(k);
  await expect(sql.raw(`INSERT INTO "talks" ("id", "status") VALUES (3, 'ACCEPTED')`).execute(k))
    .rejects.toThrow(/CHECK/i);
}

describe("SQLite null-safe CHECK spelling — opens on SQLite < 3.39", () => {
  test("a fresh migration has no DISTINCT FROM, enforces the rule, and re-diffs empty", async () => {
    const exp = await expected();
    const { up } = emit((await diff({ expected: exp, actual: { tables: [], views: [] }, dialect: "sqlite" })).changes, { dialect: "sqlite" });
    expect(up).not.toMatch(/DISTINCT\s+FROM/i);
    await migrateOnce();
    await assertRuleHolds();
    expect(await rediff()).toEqual([]);
    if (oldSqliteCli()) {
      const r = spawnSync("sqlite3", [dbFile, "SELECT count(*) FROM talks;"], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.stdout.trim()).toBe("2");
    }
  });

  test("a pre-fix database is re-spelled ONCE (ungated, no hazard), then converges", async () => {
    // Build the database exactly as the pre-fix toolchain did.
    const exp = await expected();
    const { up } = emit((await diff({ expected: exp, actual: { tables: [], views: [] }, dialect: "sqlite" })).changes, { dialect: "sqlite" });
    const legacy = up
      .replace(`"status" IS NOT 'ACCEPTED'`, `"status" IS DISTINCT FROM 'ACCEPTED'`)
      .replace(`"is_used" IS 1`, `"is_used" IS NOT DISTINCT FROM 1`);
    expect(legacy).toContain("IS DISTINCT FROM");
    expect(legacy).toContain("IS NOT DISTINCT FROM");
    await applyRaw(legacy);
    await sql.raw(`INSERT INTO "talks" ("id", "status", "slot") VALUES (10, 'ACCEPTED', 'B2')`).execute(k);

    // No allow.dropCheck passed: the respelling must not be blocked as destructive.
    const result = await migrateOnce();
    const kinds = result.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["add-check", "add-check", "drop-check", "drop-check"]);
    for (const c of result.changes) {
      expect(c.status.state).toBe("allowed");
      expect((c as { respelled?: true }).respelled).toBe(true);
    }
    expect(result.hazards ?? []).toEqual([]);

    // Data survived the rebuild, the rule still holds, and nothing drifts afterwards.
    const rows = (await sql.raw(`SELECT "id", "slot" FROM "talks"`).execute(k)).rows;
    expect(rows).toEqual([{ id: 10, slot: "B2" }]);
    await assertRuleHolds();
    expect(await rediff()).toEqual([]);
    const stored = (await sql.raw(`SELECT sql FROM sqlite_master WHERE name = 'talks'`).execute(k)).rows;
    expect(JSON.stringify(stored)).not.toMatch(/DISTINCT/i);
  });

  test("a genuine rule change is still gated, not waved through as a respelling", async () => {
    const exp = await expected();
    const { up } = emit((await diff({ expected: exp, actual: { tables: [], views: [] }, dialect: "sqlite" })).changes, { dialect: "sqlite" });
    await applyRaw(up.replace(`"status" IS NOT 'ACCEPTED'`, `"status" IS DISTINCT FROM 'DRAFT'`));
    const result = await diff({ expected: exp, actual: await introspectSqlite(k), dialect: "sqlite" });
    const drop = result.changes.find((c) => c.kind === "drop-check");
    expect(drop).toBeDefined();
    expect((drop as { respelled?: true }).respelled).toBeUndefined();
    expect(drop!.status.state).toBe("blocked");
  });
});
