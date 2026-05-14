import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { kyselyDriver } from "../../src/drivers/kysely-driver.js";
import { ConstraintViolationError } from "../../src/errors.js";
import type { PersistenceDriver } from "../../src/persistence-driver.js";

interface DB {
  posts: { id: number | null; title: string; author_id: number | null };
  users: { id: number | null; email: string };
}

let db: Kysely<DB>;
let driver: PersistenceDriver;

beforeEach(async () => {
  // Use file::memory:?cache=shared so all connections in the same process
  // share the same in-memory DB. Plain ":memory:" gives each connection its
  // own isolated DB, which breaks transactions (the outer count() sees a
  // fresh empty DB after the transaction commits).
  //
  // Because the shared DB persists across beforeEach/afterEach cycles, use
  // IF NOT EXISTS on CREATE TABLE and DELETE FROM to reset data before each test.
  db = new Kysely<DB>({ dialect: new LibsqlDialect({ url: "file::memory:?cache=shared" }) });
  await db.schema.createTable("users").ifNotExists()
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("email", "text", (c) => c.notNull().unique())
    .execute();
  await db.schema.createTable("posts").ifNotExists()
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("author_id", "integer", (c) => c.references("users.id"))
    .execute();
  // Clear data from any previous test run.
  await (db as any).deleteFrom("posts").execute();
  await (db as any).deleteFrom("users").execute();
  await db.insertInto("users").values([{ id: 10, email: "a@x" }, { id: 11, email: "b@x" }]).execute();
  await db.insertInto("posts").values([
    { id: 1, title: "Hello", author_id: 10 },
    { id: 2, title: "World", author_id: 11 },
  ]).execute();
  driver = kyselyDriver({ db, dialect: "sqlite" });
});

afterEach(async () => {
  await db.destroy();
});

describe("kyselyDriver — SQLite — selectOne / selectMany", () => {
  test("selectOne by eq", async () => {
    const row = await driver.selectOne({
      table: "posts", columns: ["id", "title"],
      where: { kind: "eq", column: "id", value: 1 },
    });
    expect(row?.title).toBe("Hello");
  });

  test("selectMany IN(...)", async () => {
    const rows = await driver.selectMany({
      table: "posts", columns: ["id"],
      where: { kind: "in", column: "id", values: [1, 2] },
    });
    expect(rows).toHaveLength(2);
  });

  test("count", async () => {
    expect(await driver.count({ table: "posts" })).toBe(2);
  });
});

describe("kyselyDriver — insert", () => {
  test("returns inserted row with auto-generated id", async () => {
    const row = await driver.insert({
      table: "posts", values: { title: "New", author_id: 10 }, returning: ["id", "title"],
    });
    expect(row.title).toBe("New");
    expect(typeof row.id).toBe("number");
  });

  test("unique violation maps to ConstraintViolationError(kind=unique)", async () => {
    await expect(driver.insert({
      table: "users", values: { email: "a@x" }, returning: ["id"],
    })).rejects.toThrow(ConstraintViolationError);
  });
});

describe("kyselyDriver — update / delete", () => {
  test("update by eq returns row", async () => {
    const row = await driver.update({
      table: "posts", values: { title: "Renamed" },
      where: { kind: "eq", column: "id", value: 1 },
      returning: ["id", "title"],
    });
    expect(row?.title).toBe("Renamed");
  });

  test("delete by eq returns 1", async () => {
    expect(await driver.delete({
      table: "posts", where: { kind: "eq", column: "id", value: 1 },
    })).toBe(1);
  });
});

describe("kyselyDriver — transactions", () => {
  test("commit on resolve", async () => {
    await driver.transaction(async (tx) => {
      await tx.insert({ table: "posts", values: { title: "tx", author_id: 10 }, returning: ["id"] });
    });
    expect(await driver.count({ table: "posts" })).toBe(3);
  });

  test("rollback on throw", async () => {
    await expect(driver.transaction(async (tx) => {
      await tx.insert({ table: "posts", values: { title: "tx", author_id: 10 }, returning: ["id"] });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await driver.count({ table: "posts" })).toBe(2);
  });
});

describe("kyselyDriver — where clause variants", () => {
  test("like", async () => {
    const rows = await driver.selectMany({
      table: "posts", columns: ["id", "title"],
      where: { kind: "like", column: "title", pattern: "Hel%" },
    });
    expect(rows).toHaveLength(1);
  });

  test("isNull", async () => {
    await db.insertInto("posts").values({ id: 5, title: "no-fk", author_id: null }).execute();
    const rows = await driver.selectMany({
      table: "posts", columns: ["id"],
      where: { kind: "isNull", column: "author_id", not: false },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(5);
  });

  test("and(...)", async () => {
    const rows = await driver.selectMany({
      table: "posts", columns: ["id"],
      where: {
        kind: "and",
        clauses: [
          { kind: "eq", column: "author_id", value: 10 },
          { kind: "like", column: "title", pattern: "Hel%" },
        ],
      },
    });
    expect(rows).toHaveLength(1);
  });
});
