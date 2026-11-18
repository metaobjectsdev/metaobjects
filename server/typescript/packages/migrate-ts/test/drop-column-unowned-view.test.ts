/**
 * A view this tool does not own is never rewritten, so it strands a column drop at apply.
 * The plan must refuse and name the view; a view that does not read the column, or has no
 * recorded body, must not block. The SQLite down must re-add the dropped column.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { diff } from "../src/diff/index.js";
import { emit } from "../src/emit/index.js";
import type { SchemaSnapshot, ViewDescriptor } from "../src/types.js";

async function load(fields: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
    "metadata.root": { children: [{
      "object.entity": { name: "Account", children: [
        { "field.long": { name: "id" } },
        { "field.string": { name: "name" } },
        ...JSON.parse(fields),
        { "source.rdb": { name: "src", "@table": "accounts" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] },
    }] },
  }))])).root;
}

const NICKNAME = '[{"field.string":{"name":"nickname"}}]';

function withViews(s: SchemaSnapshot, views: ViewDescriptor[]): SchemaSnapshot {
  return { ...s, views };
}

for (const dialect of ["postgres", "sqlite"] as const) {
  describe(`drop-column under a view the tool does not own (${dialect})`, () => {
    async function plan(views: ViewDescriptor[], unmanagedNames: string[], allow = {}) {
      const prior = withViews(buildExpectedSchema(await load(NICKNAME), { dialect }), views);
      const next = buildExpectedSchema(await load("[]"), { dialect });
      return diff({ expected: next, actual: prior, dialect, allow: { dropColumn: true, ...allow }, unmanagedNames });
    }
    const schema = dialect === "postgres" ? "public" : undefined;
    const view = (sql: string | undefined): ViewDescriptor => ({
      name: "v_hand", ...(schema !== undefined ? { schema } : {}), ...(sql !== undefined ? { sql } : {}),
    });
    const id = "public.v_hand";   // viewIdentity defaults an absent schema to "public"

    test("an @unmanaged view that reads the column blocks the drop and is named", async () => {
      const r = await plan([view("SELECT id, nickname FROM accounts")], [id]);
      expect(r.blocked.length).toBe(1);
      const status = r.blocked[0]!.status;
      expect(status).toMatchObject({ state: "blocked", blockedBy: "dropColumnReadByView" });
      expect((status as { blockedReason: string }).blockedReason).toContain("v_hand");
      expect((status as { blockedReason: string }).blockedReason).toContain("accounts.nickname");
    });

    test("allow.dropColumnReadByView lifts the block", async () => {
      const r = await plan([view("SELECT id, nickname FROM accounts")], [id], { dropColumnReadByView: true });
      expect(r.blocked).toEqual([]);
    });

    test("an @unmanaged view that does not read the column does not block", async () => {
      const r = await plan([view("SELECT id, name FROM accounts")], [id]);
      expect(r.blocked).toEqual([]);
    });

    test("a hand-made view (declared by no metadata) that reads the column blocks the drop while its drop-view is blocked", async () => {
      const r = await plan([view("SELECT id, nickname FROM accounts")], []);
      const dropColumn = r.changes.find((c) => c.kind === "drop-column")!;
      expect(dropColumn.status).toMatchObject({ state: "blocked", blockedBy: "dropColumnReadByView" });
      expect((dropColumn.status as { blockedReason: string }).blockedReason).toContain("v_hand");
    });

    test("a hand-made view whose drop-view is allowed is dropped around the change, so it does not block the drop", async () => {
      const r = await plan([view("SELECT id, nickname FROM accounts")], [], { dropView: true });
      expect(r.blocked).toEqual([]);
    });

    test("a view with no recorded body does not block", async () => {
      const r = await plan([view(undefined)], [id]);
      expect(r.blocked).toEqual([]);
    });
  });
}

describe("sqlite down of drop-column", () => {
  test("re-adds the column with its type and says the data is not restored", async () => {
    const prior = buildExpectedSchema(await load(NICKNAME), { dialect: "sqlite" });
    const next = buildExpectedSchema(await load("[]"), { dialect: "sqlite" });
    const r = await diff({ expected: next, actual: prior, dialect: "sqlite", allow: { dropColumn: true } });
    const { up, down } = emit(r.changes, { dialect: "sqlite" });
    expect(up).toContain('DROP COLUMN "nickname"');
    expect(down).toContain('ALTER TABLE "accounts" ADD COLUMN "nickname"');
    expect(down).toMatch(/column data is not restored/i);
    expect(down).not.toMatch(/TODO/);
  });

  test("D1 renders the same down", async () => {
    const prior = buildExpectedSchema(await load(NICKNAME), { dialect: "d1" });
    const next = buildExpectedSchema(await load("[]"), { dialect: "d1" });
    const r = await diff({ expected: next, actual: prior, dialect: "d1", allow: { dropColumn: true } });
    const { down } = emit(r.changes, { dialect: "d1", expectedSchema: next, actualSchema: prior });
    expect(down).toContain('ALTER TABLE "accounts" ADD COLUMN "nickname"');
  });

  test("a NOT NULL column with no default returns nullable, since SQLite cannot add it otherwise", async () => {
    const prior = buildExpectedSchema(await load('[{"field.string":{"name":"nickname","@required":true}}]'), { dialect: "sqlite" });
    const next = buildExpectedSchema(await load("[]"), { dialect: "sqlite" });
    const r = await diff({ expected: next, actual: prior, dialect: "sqlite", allow: { dropColumn: true } });
    const { down } = emit(r.changes, { dialect: "sqlite" });
    expect(down).toMatch(/ADD COLUMN "nickname" \w+(\(\d+\))?;/);
    expect(down).not.toContain("NOT NULL;");
    expect(down).toMatch(/NOT NULL with no default/);
  });
  test("rollback applies to a populated table when the dropped column had an expression or uuid default", async () => {
    // Oracle: SQLite itself refuses ADD COLUMN with a non-constant default on a table holding rows.
    const prior = buildExpectedSchema(await load(
      '[{"field.timestamp":{"name":"createdAt","@required":true}},{"field.uuid":{"name":"token","@required":true}}]',
    ), { dialect: "sqlite" });
    const createdAt = prior.tables[0]!.columns.find((c) => c.name === "created_at")!;
    createdAt.default = { kind: "expr", value: "now()" };
    const token = prior.tables[0]!.columns.find((c) => c.name === "token")!;
    token.identity = "uuid";
    delete token.default;
    const next = buildExpectedSchema(await load("[]"), { dialect: "sqlite" });
    const r = await diff({ expected: next, actual: prior, dialect: "sqlite", allow: { dropColumn: true } });
    const { down } = emit(r.changes, { dialect: "sqlite" });

    const db = new Database(":memory:");
    db.run('CREATE TABLE "accounts" ("id" INTEGER PRIMARY KEY, "name" TEXT)');
    db.run(`INSERT INTO "accounts" ("name") VALUES ('a')`);
    expect(() => db.exec(down)).not.toThrow();
    const cols = (db.query('PRAGMA table_info("accounts")').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("created_at");
    expect(cols).toContain("token");
    expect(down).toMatch(/non-constant default/);
  });
});
