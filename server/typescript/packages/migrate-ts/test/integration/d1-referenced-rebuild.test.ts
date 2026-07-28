/**
 * Bug gate for #226. On remote D1 a migration file runs inside D1's implicit
 * transaction, where `PRAGMA foreign_keys = OFF` is a no-op — so the SQLite
 * table-rebuild recipe fails to DROP a referenced parent. We reproduce that here by
 * running the emitted batch inside ONE explicit transaction on a single libSQL
 * connection with foreign_keys ON at the connection level.
 *
 * Two assertions:
 *  1. the pre-refuse D1 output for a referenced-parent rebuild DOES fail this way
 *     (documents why we refuse), and emit(dialect:d1) now throws instead;
 *  2. a leaf-table rebuild's D1 output applies cleanly and re-diffs EMPTY (we did
 *     not over-refuse).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect, libsql } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { emit } from "../../src/emit/index.js";
import { renderSqlite } from "../../src/emit/sqlite.js";
import { applyD1SafetyPass } from "../../src/emit/d1-safety-pass.js";
import { D1ReferencedTableRebuildError } from "../../src/emit/d1-fk-refuse.js";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import type { Change, SchemaSnapshot } from "../../src/types.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "d1-refuse-"));
  dbPath = join(tmpDir, "t.db");
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Apply statements inside ONE explicit transaction on a single connection (models D1). */
async function applyInImplicitTxn(stmts: string[]): Promise<{ ok: boolean; error?: string }> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA foreign_keys = ON"); // D1 remote default
  const tx = await client.transaction("write");
  try {
    for (const s of stmts) await tx.execute(s);
    await tx.commit();
    return { ok: true };
  } catch (e) {
    try { await tx.rollback(); } catch { /* ignore */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.close();
  }
}

async function execEach(stmts: string[]): Promise<void> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  for (const s of stmts) await client.execute(s);
  client.close();
}

function splitSql(sqlText: string): string[] {
  return sqlText.trim().split(";").map((s) => s.trim()).filter(Boolean);
}

const ALLOWED = { state: "allowed" } as const;

describe("#226 D1 referenced-table rebuild — real-engine gate (libSQL, one transaction = remote D1)", () => {
  test("documents the defect: the pre-refuse D1 output for a referenced-parent rebuild fails", async () => {
    // Seed: parent + child(FK->parent) with rows.
    await execEach([
      "CREATE TABLE parent (id INTEGER PRIMARY KEY, status TEXT)",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES parent(id))",
      "INSERT INTO parent (id, status) VALUES (1, 'OPEN')",
      "INSERT INTO child (id, parent_id) VALUES (1, 1)",
    ]);

    // The rebuild that #226 is about: add a CHECK to the referenced parent.
    const changes: Change[] = [
      { kind: "add-check", status: ALLOWED, table: "parent", check: { name: "parent_status_chk", expression: "status <> ''" } },
    ];
    const expected: SchemaSnapshot = {
      tables: [
        {
          name: "parent",
          columns: [
            { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
            { name: "status", sqlType: { kind: "text" }, nullable: false },
          ],
          indexes: [], foreignKeys: [], primaryKey: ["id"],
          checks: [{ name: "parent_status_chk", expression: "status <> ''" }],
        },
        {
          name: "child",
          columns: [
            { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
            { name: "parent_id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
          ],
          indexes: [],
          foreignKeys: [{ name: "child_parent_id_fk", columns: ["parent_id"], refTable: "parent", refColumns: ["id"] }],
          primaryKey: ["id"], checks: [],
        },
      ],
      views: [],
    };

    // Pre-refuse D1 output = sqlite recipe through the safety pass (BEGIN/COMMIT stripped,
    // no-op foreign_keys pragmas retained). Under the one-transaction model it fails.
    const preRefuseUp = applyD1SafetyPass(renderSqlite(changes, expected).up);
    const applied = await applyInImplicitTxn(splitSql(preRefuseUp));
    expect(applied.ok).toBe(false);
    expect(applied.error ?? "").toMatch(/FOREIGN KEY/i);

    // The fix: emit(dialect:d1) refuses to produce that SQL at all.
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).toThrow(
      D1ReferencedTableRebuildError,
    );
  });

  test("no over-refusal: a leaf-table rebuild's D1 output applies cleanly and re-diffs EMPTY", async () => {
    // A standalone table nothing references. Author it via metadata so the full
    // buildExpectedSchema → introspect → diff → emit → apply → re-diff loop runs.
    const META_V2 = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{
          "object.entity": {
            name: "LogEntry",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "level", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              // A CHECK-bearing enum forces a rebuild on the second migrate.
              { "field.enum": { name: "kind", "@values": ["A", "B"], "@required": true } },
            ],
          },
        }],
      },
    });
    // v1: same entity without the enum column, so v2 adds the CHECK → rebuild.
    const META_V1 = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{
          "object.entity": {
            name: "LogEntry",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "level", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        }],
      },
    });

    const k = new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: `file:${dbPath}` }) });
    try {
      // Apply v1 from empty.
      const root1 = (await new MetaDataLoader().load([new InMemoryStringSource(META_V1)])).root;
      const expected1 = buildExpectedSchema(root1, { dialect: "sqlite" });
      const actual0 = await introspectSqlite(k);
      const d0 = await diff({ expected: expected1, actual: actual0, dialect: "sqlite" });
      for (const stmt of splitSql(emit(d0.changes, { dialect: "d1", expectedSchema: expected1 }).up)) {
        await sql.raw(stmt).execute(k);
      }

      // v2 adds the enum CHECK → LogEntry is rebuilt. It is a leaf → must NOT refuse.
      const root2 = (await new MetaDataLoader().load([new InMemoryStringSource(META_V2)])).root;
      const expected2 = buildExpectedSchema(root2, { dialect: "sqlite" });
      const actual1 = await introspectSqlite(k);
      const d1diff = await diff({ expected: expected2, actual: actual1, dialect: "sqlite" });
      const d1Emit = emit(d1diff.changes, { dialect: "d1", expectedSchema: expected2 });
      for (const stmt of splitSql(d1Emit.up)) {
        await sql.raw(stmt).execute(k);
      }

      // Re-diff must be EMPTY (migrate-engine doctrine).
      const followup = await diff({ expected: expected2, actual: await introspectSqlite(k), dialect: "sqlite" });
      if (followup.changes.length > 0) {
        for (const c of followup.changes) console.error("residual change:", JSON.stringify(c));
      }
      expect(followup.changes).toEqual([]);
    } finally {
      await k.destroy();
    }
  });
});
