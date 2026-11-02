/**
 * Dropping a column under a view, against a real SQLite.
 *
 * - A view the tool does not own (`@unmanaged`) that still reads the dropped column is
 *   refused at plan time and named; one that does not read it is not.
 * - The down of a `drop-column` re-adds the column, so rolling back leaves the managed view
 *   the migration dropped and recreated queryable again. (D1 renders through the same path.)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  buildExpectedSchema, collectUnmanagedNames, diff, emit, introspectSqlite, type AllowOptions,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

function literalColumns<T>(root: T): T {
  (root as unknown as { physicalNaming: unknown }).physicalNaming = { columns: "literal", tables: "snake_case" };
  return root;
}

const TIMEOUT_MS = 60_000;
const NICKNAME = `{ "field.string": { "name": "nickname" } }`;
const NICKNAME_VIEW = `{ "field.string": { "name": "nickname", "extends": "Account.nickname" } }`;

function meta(withNickname: boolean, extra: string[] = []): string {
  return `{ "metadata.root": { "package": "acme", "children": [
    { "object.entity": { "name": "Account", "children": [
      { "source.rdb": { "@table": "accounts" } },
      { "field.long": { "name": "id" } },
      { "field.string": { "name": "name" } },
      ${withNickname ? NICKNAME + "," : ""}
      { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
    ] } },
    { "object.projection": { "name": "AccountView", "children": [
      { "source.rdb": { "@kind": "view", "@table": "v_account" } },
      { "identity.primary": { "name": "id", "extends": "Account.id", "@fields": "id" } },
      { "field.long": { "name": "id", "extends": "Account.id" } },
      { "field.string": { "name": "name", "extends": "Account.name" } }
      ${withNickname ? "," + NICKNAME_VIEW : ""}
    ] } }
    ${extra.map((e) => "," + e).join("\n")}
  ] } }`;
}

// A view declared @unmanaged: someone else owns its DDL, so migrate never rewrites it.
const UNMANAGED_VIEW = `{ "object.projection": { "name": "HandView", "children": [
  { "source.rdb": { "@kind": "view", "@table": "v_hand", "@unmanaged": true } },
  { "identity.primary": { "name": "id", "extends": "Account.id", "@fields": "id" } },
  { "field.long": { "name": "id", "extends": "Account.id" } }
] } }`;

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "drop-column-view-sqlite-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "test.db")}` }) });
});
afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

// libsql execute() is single-statement; no emitted body here carries an inner ";".
async function applyRaw(text: string): Promise<void> {
  for (const stmt of text.split("\n").filter((l) => !l.startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

async function migrate(metaJson: string, allow: AllowOptions = {}) {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
  const expected = buildExpectedSchema(literalColumns(root), {
    dialect: "sqlite",
    views: buildProjectionViews(literalColumns(root), { dialect: "sqlite" }),
  });
  const actual = await introspectSqlite(k);
  const result = await diff({ expected, actual, dialect: "sqlite", allow, unmanagedNames: collectUnmanagedNames(root) });
  const emittable = result.changes.filter((c) => c.status.state !== "blocked");
  const out = emittable.length === 0
    ? { up: "", down: "" }
    : emit(emittable, {
      dialect: "sqlite", expectedSchema: expected, actualSchema: actual,
      ...(actual.meta !== undefined && { actualMeta: actual.meta }),
    });
  if (result.blocked.length === 0 && out.up.trim().length > 0) await applyRaw(out.up);
  return { result, ...out };
}

describe("drop-column under a view — real SQLite", () => {
  test("an unmanaged view that reads the dropped column is blocked and named; the DB is untouched", async () => {
    await migrate(meta(true, [UNMANAGED_VIEW]));
    await sql.raw(`CREATE VIEW "v_hand" AS SELECT "id", "nickname" FROM "accounts"`).execute(k);

    const { result } = await migrate(meta(false, [UNMANAGED_VIEW]), { dropColumn: true });
    const blocked = result.blocked.find((c) => c.kind === "drop-column");
    expect(blocked?.status).toMatchObject({ state: "blocked", blockedBy: "dropColumnReadByView" });
    expect(blocked?.status.blockedReason).toContain("v_hand");
    expect(blocked?.status.blockedReason).toContain("accounts.nickname");

    // With the flag the plan is allowed through.
    await expect(migrate(meta(false, [UNMANAGED_VIEW]), { dropColumn: true, dropColumnReadByView: true }))
      .rejects.toThrow(/v_hand/);   // SQLite then refuses the drop at apply: the view still reads it
  }, TIMEOUT_MS);

  test("an unmanaged view that does not read the dropped column is not blocked", async () => {
    await migrate(meta(true, [UNMANAGED_VIEW]));
    await sql.raw(`CREATE VIEW "v_hand" AS SELECT "id", "name" FROM "accounts"`).execute(k);

    const { result } = await migrate(meta(false, [UNMANAGED_VIEW]), { dropColumn: true });
    expect(result.blocked).toEqual([]);
    await sql.raw(`SELECT * FROM "v_hand"`).execute(k);
  }, TIMEOUT_MS);

  test("rolling back a drop-column re-adds it, and the managed view is queryable again", async () => {
    await migrate(meta(true));
    await sql.raw(`INSERT INTO "accounts" ("id","name","nickname") VALUES (1,'a','n1'),(2,'b','n2')`).execute(k);

    const { result, down } = await migrate(meta(false), { dropColumn: true, dropView: true });
    expect(result.blocked).toEqual([]);
    expect(down).toContain(`ADD COLUMN "nickname"`);
    // Applied: the column and the view's column are gone.
    await expect(sql.raw(`SELECT "nickname" FROM "v_account"`).execute(k)).rejects.toThrow();

    await applyRaw(down);
    const rows = await sql.raw(`SELECT * FROM "v_account" ORDER BY "id"`).execute(k);
    expect(rows.rows).toHaveLength(2);
    expect(Object.keys(rows.rows[0] as object)).toContain("nickname");
    // The data is not restored, and the migration says so.
    expect((rows.rows[0] as { nickname: unknown }).nickname).toBeNull();
    expect(down).toMatch(/column data is not restored/i);
  }, TIMEOUT_MS);
});
