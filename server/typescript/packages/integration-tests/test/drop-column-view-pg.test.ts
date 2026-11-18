/**
 * Dropping a column under a view the tool does not own, against a real Postgres.
 *
 * An `@unmanaged` view that still reads the dropped column is refused at plan time and
 * named (Postgres otherwise fails at apply: "cannot drop column … other objects depend on
 * it"); one that does not read it is not blocked, and applies.
 */
import { splitSqlStatements } from "@metaobjectsdev/migrate-ts";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  buildExpectedSchema, collectUnmanagedNames, diff, emit, introspectPostgres, postgresViewReplaceProbe,
  type AllowOptions,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

function literalColumns<T>(root: T): T {
  (root as unknown as { physicalNaming: unknown }).physicalNaming = { columns: "literal", tables: "snake_case" };
  return root;
}

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

let pg: RunningPg;
let k: Kysely<Record<string, unknown>>;

beforeAll(async () => {
  pg = await startPostgres();
  k = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: pg.connectionUri }) }),
  });
}, 120_000);
afterAll(async () => {
  await k.destroy();
  await pg.stop();
}, 60_000);
beforeEach(async () => {
  await sql.raw("DROP SCHEMA public CASCADE").execute(k);
  await sql.raw("CREATE SCHEMA public").execute(k);
});

async function applyRaw(text: string): Promise<void> {
  for (const stmt of splitSqlStatements(text)) await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
}

async function migrate(metaJson: string, allow: AllowOptions = {}) {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
  const expected = buildExpectedSchema(literalColumns(root), {
    views: buildProjectionViews(literalColumns(root), { dialect: "postgres" }),
  });
  const result = await diff({
    expected, actual: await introspectPostgres(k), dialect: "postgres",
    viewReplaceProbe: postgresViewReplaceProbe(k), allow, unmanagedNames: collectUnmanagedNames(root),
  });
  const emittable = result.changes.filter((c) => c.status.state !== "blocked");
  const out = emittable.length === 0 ? { up: "", down: "" } : emit(emittable, { dialect: "postgres" });
  if (result.blocked.length === 0 && out.up.trim().length > 0) await applyRaw(out.up);
  return { result, ...out };
}

describe("drop-column under a view the tool does not own — real Postgres", () => {
  test("an unmanaged view that reads the dropped column is blocked and named; the DB is untouched", async () => {
    await migrate(meta(true, [UNMANAGED_VIEW]));
    await sql.raw(`CREATE VIEW "v_hand" AS SELECT "id", "nickname" FROM "accounts"`).execute(k);

    const { result } = await migrate(meta(false, [UNMANAGED_VIEW]), { dropColumn: true });
    const blocked = result.blocked.find((c) => c.kind === "drop-column");
    expect(blocked?.status).toMatchObject({ state: "blocked", blockedBy: "dropColumnReadByView" });
    expect(blocked?.status.blockedReason).toContain("v_hand");
    expect(blocked?.status.blockedReason).toContain("accounts.nickname");

    // The plan it refused is the one Postgres fails at apply.
    await expect(migrate(meta(false, [UNMANAGED_VIEW]), { dropColumn: true, dropColumnReadByView: true }))
      .rejects.toThrow(/depend on it/);
  }, 60_000);

  test("an unmanaged view that does not read the dropped column is not blocked", async () => {
    await migrate(meta(true, [UNMANAGED_VIEW]));
    await sql.raw(`CREATE VIEW "v_hand" AS SELECT "id", "name" FROM "accounts"`).execute(k);

    const { result } = await migrate(meta(false, [UNMANAGED_VIEW]), { dropColumn: true });
    expect(result.blocked).toEqual([]);
    await sql.raw(`SELECT * FROM "v_hand"`).execute(k);
  }, 60_000);
});
