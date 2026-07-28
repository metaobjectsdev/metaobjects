/**
 * #243 probe — a dependent VIEW over a table REBUILT by a non-column-altering change
 * (enum @values / CHECK), on SQLite and on the D1 cascade.
 *
 * Concern (from the #241 final review): Pass 2c injects a view drop/recreate only for
 * COLUMN-altering changes, so a CHECK/FK/enum-triggered rebuild (or a D1 cascade referrer
 * rebuild) of a table a view reads might break the view. This reproduces it on a real
 * engine to decide: real bug (fix) or not (close with proof). Runs against the built
 * @metaobjectsdev/migrate-ts (this package depends on the published/built API).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect, libsql } from "@libsql/kysely-libsql";
import { buildExpectedSchema, diff, emit, introspectSqlite } from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

let tmpDir: string;
let dbPath: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "d1-243-"));
  dbPath = join(tmpDir, "t.db");
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${dbPath}` }) });
});
afterEach(async () => { await k.destroy(); rmSync(tmpDir, { recursive: true, force: true }); });

function splitSql(text: string): string[] {
  return text.trim().split(";").map((s) => s.trim()).filter(Boolean);
}
async function applyRaw(text: string): Promise<void> {
  for (const stmt of splitSql(text)) await sql.raw(stmt).execute(k);
}
/** Apply statements inside ONE libSQL transaction with foreign_keys=ON — models remote D1. */
async function applyInImplicitTxn(stmts: string[]): Promise<{ ok: boolean; error?: string }> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA foreign_keys = ON");
  const tx = await client.transaction("write");
  try {
    for (const s of stmts) await tx.execute(s);
    await tx.commit();
    return { ok: true };
  } catch (e) {
    try { await tx.rollback(); } catch { /* ignore */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally { client.close(); }
}

// v1 / v2 differ only by Program.status enum @values (DRAFT,PUBLISHED) → (+ARCHIVED).
// An enum @values change lowers to a CHECK change on SQLite → recreate-and-copy of
// `programs`. The view v_program_summary READS programs.status (isPublished) + id.
function meta(values: string[]): string {
  return JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Program", children: [
      { "source.rdb": { "@table": "programs" } },
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": values, "@required": true } },
      { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    ] } },
    { "object.projection": { name: "ProgramSummary", children: [
      { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
      { "identity.primary": { name: "id", extends: "Program.id", "@fields": "id" } },
      { "field.long": { name: "id", extends: "Program.id", children: [
        { "origin.passthrough": { "@from": "Program.id" } } ] } },
      { "field.boolean": { name: "isPublished", children: [
        { "origin.computed": { "@expr": { op: "eq", left: { field: "status" }, right: { value: "PUBLISHED" } } } } ] } },
    ] } },
  ]}});
}

async function build(values: string[], dialect: "sqlite" | "d1") {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(meta(values))])).root;
  const columnNamingStrategy = "literal" as const;
  return buildExpectedSchema(root, {
    dialect, columnNamingStrategy,
    views: buildProjectionViews(root, { dialect, columnNamingStrategy }),
  });
}

describe("#243 — dependent view over an enum/CHECK-rebuilt table", () => {
  test("SQLite: enum @values change on a VIEWED column rebuilds the table; view survives + re-diff EMPTY", async () => {
    const expected1 = await build(["DRAFT", "PUBLISHED"], "sqlite");
    const actual0 = await introspectSqlite(k);
    const d0 = await diff({ expected: expected1, actual: actual0, dialect: "sqlite" });
    await applyRaw(emit(d0.changes, { dialect: "sqlite", expectedSchema: expected1,
      ...(actual0.meta !== undefined && { actualMeta: actual0.meta }) }).up);

    await sql.raw(`INSERT INTO "programs" ("id","status") VALUES (1,'PUBLISHED'),(2,'DRAFT')`).execute(k);
    const before = await sql.raw(`SELECT "id","isPublished" FROM "v_program_summary" ORDER BY "id"`).execute(k);
    expect(before.rows.length).toBe(2);

    const expected2 = await build(["DRAFT", "PUBLISHED", "ARCHIVED"], "sqlite");
    const actual1 = await introspectSqlite(k);
    const d1diff = await diff({ expected: expected2, actual: actual1, dialect: "sqlite", allow: { dropCheck: true } });
    expect(d1diff.changes.length).toBeGreaterThan(0); // there IS a rebuild
    const up = emit(d1diff.changes, { dialect: "sqlite", expectedSchema: expected2,
      ...(actual1.meta !== undefined && { actualMeta: actual1.meta }) }).up;
    await applyRaw(up);

    const after = await sql.raw(`SELECT "id","isPublished" FROM "v_program_summary" ORDER BY "id"`).execute(k);
    expect(after.rows.length).toBe(2);
    expect((after.rows as Array<{ id: number; isPublished: number }>).map((r) => r.isPublished)).toEqual([1, 0]);

    const followup = await diff({ expected: expected2, actual: await introspectSqlite(k), dialect: "sqlite" });
    expect(followup.changes).toEqual([]);
  });

  test("D1 cascade: enum @values change on a VIEWED table applies in one-txn; view survives + re-diff EMPTY", async () => {
    const expected1 = await build(["DRAFT", "PUBLISHED"], "d1");
    const actual0 = await introspectSqlite(k);
    const d0 = await diff({ expected: expected1, actual: actual0, dialect: "d1" });
    await applyRaw(emit(d0.changes, { dialect: "d1", expectedSchema: expected1, actualSchema: actual0,
      ...(actual0.meta !== undefined && { actualMeta: actual0.meta }) }).up);
    await sql.raw(`INSERT INTO "programs" ("id","status") VALUES (1,'PUBLISHED'),(2,'DRAFT')`).execute(k);

    const expected2 = await build(["DRAFT", "PUBLISHED", "ARCHIVED"], "d1");
    const actual1 = await introspectSqlite(k);
    const d1diff = await diff({ expected: expected2, actual: actual1, dialect: "d1", allow: { dropCheck: true } });
    const up = emit(d1diff.changes, { dialect: "d1", expectedSchema: expected2, actualSchema: actual1,
      ...(actual1.meta !== undefined && { actualMeta: actual1.meta }) }).up;
    const res = await applyInImplicitTxn(splitSql(up));
    expect(res).toEqual({ ok: true });

    const after = await sql.raw(`SELECT "id","isPublished" FROM "v_program_summary" ORDER BY "id"`).execute(k);
    expect(after.rows.length).toBe(2);

    const followup = await diff({ expected: expected2, actual: await introspectSqlite(k), dialect: "d1" });
    expect(followup.changes).toEqual([]);
  });

  // Case 2: a view over a table pulled into the D1 cascade ONLY as an FK referrer (the
  // referrer itself is unchanged). Rebuild the PARENT via an enum change → the cascade
  // rebuilds the child too → a view on the child must survive.
  function metaChild(values: string[]): string {
    return JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "source.rdb": { "@table": "programs" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "status", "@values": values, "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Note", children: [
        { "source.rdb": { "@table": "notes" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId", "@required": true } },
        { "field.string": { name: "body", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
      ] } },
      { "object.projection": { name: "NoteSummary", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_note" } },
        { "identity.primary": { name: "id", extends: "Note.id", "@fields": "id" } },
        { "field.long": { name: "id", extends: "Note.id", children: [
          { "origin.passthrough": { "@from": "Note.id" } } ] } },
        { "field.string": { name: "body", extends: "Note.body", children: [
          { "origin.passthrough": { "@from": "Note.body" } } ] } },
      ] } },
    ]}});
  }
  async function buildChild(values: string[]) {
    const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaChild(values))])).root;
    const columnNamingStrategy = "literal" as const;
    return buildExpectedSchema(root, {
      dialect: "d1", columnNamingStrategy,
      views: buildProjectionViews(root, { dialect: "d1", columnNamingStrategy }),
    });
  }

  test("D1 cascade referrer: view on a child pulled in via FK survives the parent rebuild + re-diff EMPTY", async () => {
    const expected1 = await buildChild(["DRAFT", "PUBLISHED"]);
    const actual0 = await introspectSqlite(k);
    const d0 = await diff({ expected: expected1, actual: actual0, dialect: "d1" });
    await applyRaw(emit(d0.changes, { dialect: "d1", expectedSchema: expected1, actualSchema: actual0,
      ...(actual0.meta !== undefined && { actualMeta: actual0.meta }) }).up);
    await sql.raw(`INSERT INTO "programs" ("id","status") VALUES (1,'PUBLISHED')`).execute(k);
    await sql.raw(`INSERT INTO "notes" ("id","programId","body") VALUES (1,1,'hello')`).execute(k);

    const expected2 = await buildChild(["DRAFT", "PUBLISHED", "ARCHIVED"]);
    const actual1 = await introspectSqlite(k);
    const d1diff = await diff({ expected: expected2, actual: actual1, dialect: "d1", allow: { dropCheck: true } });
    const up = emit(d1diff.changes, { dialect: "d1", expectedSchema: expected2, actualSchema: actual1,
      ...(actual1.meta !== undefined && { actualMeta: actual1.meta }) }).up;
    const res = await applyInImplicitTxn(splitSql(up));
    expect(res).toEqual({ ok: true });

    const after = await sql.raw(`SELECT "id","body" FROM "v_note" ORDER BY "id"`).execute(k);
    expect(after.rows.length).toBe(1);

    const followup = await diff({ expected: expected2, actual: await introspectSqlite(k), dialect: "d1" });
    expect(followup.changes).toEqual([]);
  });

  // Case 3: cascade fires (parent referenced by a child) AND a view is on the DIRECTLY
  // changed parent — so the diff DOES inject a drop-view/create-view that must be
  // suppressed from `rest` and emitted by the cascade in the correct order instead.
  function metaParentView(values: string[]): string {
    return JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "source.rdb": { "@table": "programs" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "status", "@values": values, "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Note", children: [
        { "source.rdb": { "@table": "notes" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
      ] } },
      { "object.projection": { name: "ProgramView", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_program" } },
        { "identity.primary": { name: "id", extends: "Program.id", "@fields": "id" } },
        { "field.long": { name: "id", extends: "Program.id", children: [
          { "origin.passthrough": { "@from": "Program.id" } } ] } },
        { "field.boolean": { name: "isPublished", children: [
          { "origin.computed": { "@expr": { op: "eq", left: { field: "status" }, right: { value: "PUBLISHED" } } } } ] } },
      ] } },
    ]}});
  }
  async function buildParentView(values: string[]) {
    const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaParentView(values))])).root;
    const columnNamingStrategy = "literal" as const;
    return buildExpectedSchema(root, {
      dialect: "d1", columnNamingStrategy,
      views: buildProjectionViews(root, { dialect: "d1", columnNamingStrategy }),
    });
  }

  test("D1 cascade + view on the DIRECTLY-changed parent: no double-emit, view survives + re-diff EMPTY", async () => {
    const expected1 = await buildParentView(["DRAFT", "PUBLISHED"]);
    const actual0 = await introspectSqlite(k);
    const d0 = await diff({ expected: expected1, actual: actual0, dialect: "d1" });
    await applyRaw(emit(d0.changes, { dialect: "d1", expectedSchema: expected1, actualSchema: actual0,
      ...(actual0.meta !== undefined && { actualMeta: actual0.meta }) }).up);
    await sql.raw(`INSERT INTO "programs" ("id","status") VALUES (1,'PUBLISHED')`).execute(k);
    await sql.raw(`INSERT INTO "notes" ("id","programId") VALUES (1,1)`).execute(k);

    const expected2 = await buildParentView(["DRAFT", "PUBLISHED", "ARCHIVED"]);
    const actual1 = await introspectSqlite(k);
    const d1diff = await diff({ expected: expected2, actual: actual1, dialect: "d1", allow: { dropCheck: true } });
    const up = emit(d1diff.changes, { dialect: "d1", expectedSchema: expected2, actualSchema: actual1,
      ...(actual1.meta !== undefined && { actualMeta: actual1.meta }) }).up;
    // the view is dropped/created exactly once (cascade owns it; not double-emitted from rest)
    expect(up.match(/DROP VIEW IF EXISTS "v_program"/g)?.length).toBe(1);
    expect(up.match(/CREATE VIEW "v_program"/g)?.length).toBe(1);
    const res = await applyInImplicitTxn(splitSql(up));
    expect(res).toEqual({ ok: true });

    const after = await sql.raw(`SELECT "id","isPublished" FROM "v_program" ORDER BY "id"`).execute(k);
    expect(after.rows.length).toBe(1);

    const followup = await diff({ expected: expected2, actual: await introspectSqlite(k), dialect: "d1" });
    expect(followup.changes).toEqual([]);
  });
});
