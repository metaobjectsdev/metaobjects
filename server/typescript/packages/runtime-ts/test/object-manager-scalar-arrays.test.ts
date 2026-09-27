// A scalar array field (`field.string isArray`) through the ObjectManager. It never worked:
// the validator type-checked the array as ONE string, so every write failed `tags: type`.
// Behind that, the Kysely driver bound the JS array directly, which libsql cannot do (it
// panics) and mysql2 expands into a value list. Now: element-wise validation; the Kysely
// driver binds a scalar array as JSON text on SQLite and MySQL (Postgres keeps its native
// array); a JSON-text array reads back as an array.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { newDb } from "pg-mem";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { ObjectManager, type Row } from "../src/index.js";
import { kyselyDriver } from "../src/drivers/index.js";

const MODEL = { "metadata.root": { package: "p", children: [{ "object.entity": { name: "A", children: [
  { "source.rdb": { "@table": "a" } },
  { "field.long": { name: "id" } },
  { "field.string": { name: "tags", isArray: true } },
  { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
] } }] } };

async function root(): Promise<MetaRoot> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(r.errors).toEqual([]);
  return r.root;
}

test("SQLite (Kysely/libsql): a string array round-trips through a JSON-text column", async () => {
  const dir = mkdtempSync(join(tmpdir(), "om-arrays-"));
  const db = new Kysely<Record<string, Row>>({ dialect: new LibsqlDialect({ url: `file:${join(dir, "t.db")}` }) });
  try {
    await sql.raw("CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, tags TEXT)").execute(db);
    const om = new ObjectManager({ metadata: await root(), driver: kyselyDriver({ db, dialect: "sqlite" }) });
    const created = await om.create("A", { tags: ["x", "y"] });
    expect(created.tags).toEqual(["x", "y"]);
    expect((await om.update("A", created.id, { tags: ["z"] }))?.tags).toEqual(["z"]);
    expect((await om.findById("A", created.id))?.tags).toEqual(["z"]);
  } finally {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Postgres (Kysely/pg-mem): a string array stays a native text[]", async () => {
  const db = newDb().adapters.createKysely() as Kysely<Record<string, Row>>;
  await sql.raw("CREATE TABLE a (id bigserial PRIMARY KEY, tags text[])").execute(db);
  const om = new ObjectManager({ metadata: await root(), driver: kyselyDriver({ db, dialect: "postgres" }) });
  const created = await om.create("A", { tags: ["x", "y"] });
  expect(created.tags).toEqual(["x", "y"]);
  await db.destroy();
});
