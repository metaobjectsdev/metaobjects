// A project declaring `migrate.scope` writes the OTHER owner's tables into its
// committed snapshot on purpose (`carryForwardOutOfScope`), and its chain — also on
// purpose — never creates them. Without threading the scope decision, every replay
// of such a project reports those tables as missing.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReplay } from "../../src/verify/replay.js";
import { openReplayEngine } from "../../src/verify/replay-engine.js";
import type { SchemaSnapshot, TableDescriptor } from "../../src/types.js";

function chainWith(upSql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-scoped-"));
  mkdirSync(join(dir, "20260101000000-init"), { recursive: true });
  writeFileSync(join(dir, "20260101000000-init", "up.sql"), upSql, "utf8");
  writeFileSync(join(dir, "20260101000000-init", "down.sql"), 'DROP TABLE "mine";', "utf8");
  return dir;
}

// `id INTEGER NOT NULL PRIMARY KEY`, not a bare `INTEGER PRIMARY KEY`: sqlite reports
// notnull=0 for the latter, so `nullable: false` below would read as drift and both
// tests would answer a question about column nullability rather than about scope.
const CHAIN = 'CREATE TABLE "mine" (id INTEGER NOT NULL PRIMARY KEY);';

const table = (name: string): TableDescriptor => ({
  name,
  columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
  indexes: [],
  foreignKeys: [],
  checks: [],
  primaryKey: ["id"],
});

const SNAPSHOT: SchemaSnapshot = { tables: [table("mine"), table("theirs")], views: [] };

describe("verifyReplay honours migrate.scope", () => {
  test("an out-of-scope table in the snapshot is not reported as missing", async () => {
    const dir = chainWith(CHAIN);
    const engine = await openReplayEngine("sqlite");
    try {
      const result = await verifyReplay({
        db: engine.db,
        dialect: "sqlite",
        migrationsDir: dir,
        snapshot: SNAPSHOT,
        // Qualified `<schema>.<name>`; an absent schema normalizes to the Postgres
        // default, and every sqlite object lands under that same constant prefix.
        governed: { outOfScope: ["public.theirs"] },
      });
      expect(result.ok).toBe(true);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The control is what makes the case above non-vacuous: it proves the difference
  // comes from `governed`, not from a fixture that was trivially green.
  test("without `governed`, the same case reports drift — the control", async () => {
    const dir = chainWith(CHAIN);
    const engine = await openReplayEngine("sqlite");
    try {
      const result = await verifyReplay({
        db: engine.db,
        dialect: "sqlite",
        migrationsDir: dir,
        snapshot: SNAPSHOT,
      });
      expect(result.ok).toBe(false);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An empty `outOfScope` must not become a way to suppress a real difference.
  test("an empty scope still reports drift", async () => {
    const dir = chainWith(CHAIN);
    const engine = await openReplayEngine("sqlite");
    try {
      const result = await verifyReplay({
        db: engine.db,
        dialect: "sqlite",
        migrationsDir: dir,
        snapshot: SNAPSHOT,
        governed: { outOfScope: [] },
      });
      expect(result.ok).toBe(false);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
