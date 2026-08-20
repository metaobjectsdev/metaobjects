// #313, end to end: the EMITTER's own output, written by `writeMigration`, applied
// by `applyPending` into an empty database.
//
// Every prior defect in this area (#226/#241, #243, #255, #285, and 0.21.4's
// `BEGIN TRANSACTION` finding) shared one shape — SQL proven statement-by-statement
// and never proven through the tool that applies it. `applyPending` splits and
// rewrites statements before executing them, so an emit-level string assertion
// cannot see this class of bug. A hand-written-SQL test cannot either: it stays
// green no matter what the emitter does.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit } from "../../src/emit/index.js";
import { writeMigration } from "../../src/write-migration.js";
import { applyPending } from "../../src/apply/apply.js";
import { openReplayEngine } from "../../src/verify/replay-engine.js";
import type { Change, ChangeStatus } from "../../src/types.js";

const ALLOWED: ChangeStatus = { state: "allowed" };

// Exactly the reported shape: another tool owned `theirs`, so the diff proposed
// dropping it, and no migration in the chain ever created it.
const REPORTED: Change[] = [
  {
    kind: "create-table",
    status: ALLOWED,
    table: {
      name: "mine",
      columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
      indexes: [],
      foreignKeys: [],
      checks: [],
      primaryKey: ["id"],
    },
  },
  { kind: "drop-table", table: "theirs", status: ALLOWED },
];

describe("an EMITTED chain applies to an empty database (#313)", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    test(`${dialect}: emit → writeMigration → applyPending, from empty`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `replay-emitted-${dialect}-`));
      const engine = await openReplayEngine(dialect);
      try {
        await writeMigration(emit(REPORTED, { dialect }), { dir, slug: "init" });
        const applied = await applyPending(engine.db, dir, { dryRun: false, dialect });
        expect(applied.applied).toHaveLength(1);
      } finally {
        await engine.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // A chain creating a table in a non-default schema needs `CREATE SCHEMA` ahead of
  // it, which no migration used to emit. Postgres-only — sqlite has no schemas.
  test("postgres: an emitted chain creating a non-default schema's table applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-emitted-schema-"));
    const engine = await openReplayEngine("postgres");
    try {
      await writeMigration(
        emit(
          [
            {
              kind: "create-table",
              status: ALLOWED,
              table: {
                name: "x",
                schema: "reporting",
                columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
                indexes: [],
                foreignKeys: [],
                checks: [],
                primaryKey: ["id"],
              },
            },
          ],
          { dialect: "postgres" },
        ),
        { dir, slug: "init" },
      );
      const applied = await applyPending(engine.db, dir, { dryRun: false, dialect: "postgres" });
      expect(applied.applied).toHaveLength(1);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F10 — the CONSTRAINT-level analogue of the REPORTED case above: `theirs` is
  // never created by this chain, and the diff proposes dropping an FK, a CHECK,
  // and a constraint-backed (unique) index on it — the three change kinds whose
  // renderer guards the CONSTRAINT name with `IF EXISTS` but leaves the
  // enclosing `ALTER TABLE` bare, so it still fails against a virgin database
  // with `relation "theirs" does not exist`; the #313 guarantee was partial for
  // exactly these three kinds. Postgres-only: SQLite emits no standalone
  // statement for drop-fk/drop-check at all (folded into a table recreate that
  // rebuilds from the EXPECTED descriptor), so it cannot exhibit this bug.
  test("postgres: dropping an fk/check/constraint-backed-index on a table the chain never created still applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-emitted-unmanaged-constraint-"));
    const engine = await openReplayEngine("postgres");
    const unmanagedConstraintDrops: Change[] = [
      {
        kind: "create-table",
        status: ALLOWED,
        table: {
          name: "mine",
          columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
          indexes: [],
          foreignKeys: [],
          checks: [],
          primaryKey: ["id"],
        },
      },
      { kind: "drop-fk", table: "theirs", fk: "theirs_owner_fk", status: ALLOWED },
      { kind: "drop-check", table: "theirs", check: "theirs_status_chk", status: ALLOWED },
      {
        kind: "drop-index", table: "theirs", index: "theirs_code_uniq", status: ALLOWED,
        restore: { name: "theirs_code_uniq", columns: ["code"], unique: true, constraint: "unique" },
      },
    ];
    try {
      await writeMigration(emit(unmanagedConstraintDrops, { dialect: "postgres" }), { dir, slug: "init" });
      const applied = await applyPending(engine.db, dir, { dryRun: false, dialect: "postgres" });
      expect(applied.applied).toHaveLength(1);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The control: without it the cases above could pass because `applyPending`
  // swallows a failing statement rather than because the emitter stopped writing
  // one. This proves the assertion has teeth.
  test("the control: a HAND-WRITTEN bare drop still fails the replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-emitted-control-"));
    const engine = await openReplayEngine("sqlite");
    try {
      await writeMigration(
        {
          up: 'CREATE TABLE "mine" (id INTEGER NOT NULL PRIMARY KEY);\n\nDROP TABLE "theirs";',
          down: 'DROP TABLE "mine";',
        },
        { dir, slug: "init" },
      );
      await expect(applyPending(engine.db, dir, { dryRun: false, dialect: "sqlite" }))
        .rejects.toThrow(/theirs/);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
