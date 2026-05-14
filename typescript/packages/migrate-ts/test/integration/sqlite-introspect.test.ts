import { test, expect, beforeAll, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { introspect } from "../../src/introspect/index.js";


let tmpDir: string;
let kysely: Kysely<Record<string, unknown>>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-sqlite-"));
  const url = `file:${join(tmpDir, "test.db")}`;
  kysely = new Kysely({ dialect: new LibsqlDialect({ url }) });

  await kysely.schema
    .createTable("users")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("email", "text", (c) => c.notNull())
    .addColumn("first_name", "text")
    .addColumn("is_active", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("price_cents", "integer")
    .execute();
});

afterAll(async () => {
  await kysely.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("introspectSqlite — tables + columns", () => {
  test("introspects table users", async () => {
    const snapshot = await introspectSqlite(kysely);
    expect(snapshot.tables.find((t) => t.name === "users")).toBeDefined();
  });

  test("text → text(unbounded)", async () => {
    const snapshot = await introspectSqlite(kysely);
    const email = snapshot.tables.find((t) => t.name === "users")?.columns.find((c) => c.name === "email");
    expect(email?.sqlType).toEqual({ kind: "text" });
    expect(email?.nullable).toBe(false);
  });

  test("INTEGER PRIMARY KEY AUTOINCREMENT → integer{64} + identity=increment", async () => {
    const snapshot = await introspectSqlite(kysely);
    const id = snapshot.tables.find((t) => t.name === "users")?.columns.find((c) => c.name === "id");
    // SQLite stores INTEGER as 64-bit; we report integer{64}.
    expect(id?.sqlType).toEqual({ kind: "integer", bits: 64 });
    expect(id?.identity).toBe("increment");
  });

  test("primary key", async () => {
    const snapshot = await introspectSqlite(kysely);
    expect(snapshot.tables.find((t) => t.name === "users")?.primaryKey).toEqual(["id"]);
  });

  test("snapshot.meta.sqliteVersion populated", async () => {
    const snapshot = await introspectSqlite(kysely);
    expect(snapshot.meta?.sqliteVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("snapshot.views always present (empty for v0.1 with no views)", async () => {
    const snapshot = await introspectSqlite(kysely);
    expect(Array.isArray(snapshot.views)).toBe(true);
  });
});

describe("introspectSqlite — indexes + FKs", () => {
  let kysely2: Kysely<Record<string, unknown>>;
  let tmpDir2: string;

  beforeAll(async () => {
    tmpDir2 = mkdtempSync(join(tmpdir(), "migrate-ts-sqlite-idx-"));
    const url = `file:${join(tmpDir2, "test.db")}`;
    kysely2 = new Kysely({ dialect: new LibsqlDialect({ url }) });

    await kysely2.schema
      .createTable("programs")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("slug", "text", (c) => c.notNull().unique())
      .execute();
    await kysely2.schema
      .createTable("weeks")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("program_id", "integer", (c) => c.notNull().references("programs.id").onDelete("cascade"))
      .addColumn("week_number", "integer", (c) => c.notNull())
      .execute();
    await kysely2.schema
      .createIndex("weeks_program_id_idx")
      .on("weeks")
      .column("program_id")
      .execute();
  });

  afterAll(async () => {
    await kysely2.destroy();
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  test("captures unique index from UNIQUE constraint", async () => {
    const snapshot = await introspectSqlite(kysely2);
    const programs = snapshot.tables.find((t) => t.name === "programs");
    const slugIdx = programs?.indexes.find((i) => i.columns.includes("slug"));
    expect(slugIdx?.unique).toBe(true);
  });

  test("captures non-unique named index", async () => {
    const snapshot = await introspectSqlite(kysely2);
    const weeks = snapshot.tables.find((t) => t.name === "weeks");
    const idx = weeks?.indexes.find((i) => i.name === "weeks_program_id_idx");
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(false);
  });

  test("captures FK with onDelete=cascade", async () => {
    const snapshot = await introspectSqlite(kysely2);
    const weeks = snapshot.tables.find((t) => t.name === "weeks");
    expect(weeks?.foreignKeys).toHaveLength(1);
    const fk = weeks?.foreignKeys[0];
    expect(fk?.columns).toEqual(["program_id"]);
    expect(fk?.refTable).toBe("programs");
    expect(fk?.refColumns).toEqual(["id"]);
    expect(fk?.onDelete).toBe("cascade");
  });

  test("PK index NOT reported as a regular index", async () => {
    const snapshot = await introspectSqlite(kysely2);
    const programs = snapshot.tables.find((t) => t.name === "programs");
    const pkIdx = programs?.indexes.find((i) => i.columns.length === 1 && i.columns[0] === "id");
    expect(pkIdx).toBeUndefined();
  });
});

describe("introspectSqlite — views + dispatcher", () => {
  test("captures view names", async () => {
    const tmpV = mkdtempSync(join(tmpdir(), "migrate-ts-sqlite-view-"));
    const url = `file:${join(tmpV, "test.db")}`;
    const k = new Kysely({ dialect: new LibsqlDialect({ url }) });
    try {
      await k.schema.createTable("orders").addColumn("id", "integer", (c) => c.primaryKey()).execute();
      await sql`CREATE VIEW order_summary AS SELECT id FROM orders`.execute(k as never);
      const snapshot = await introspectSqlite(k);
      expect(snapshot.views.map((v) => v.name)).toContain("order_summary");
    } finally {
      await k.destroy();
      rmSync(tmpV, { recursive: true, force: true });
    }
  });

  test("dispatcher routes 'sqlite' to introspectSqlite", async () => {
    const tmpD = mkdtempSync(join(tmpdir(), "migrate-ts-sqlite-disp-"));
    const url = `file:${join(tmpD, "test.db")}`;
    const k = new Kysely({ dialect: new LibsqlDialect({ url }) });
    try {
      await k.schema.createTable("t").addColumn("id", "integer", (c) => c.primaryKey()).execute();
      const snapshot = await introspect(k, "sqlite");
      expect(snapshot.tables.find((t) => t.name === "t")).toBeDefined();
      expect(snapshot.meta?.sqliteVersion).toBeDefined();
    } finally {
      await k.destroy();
      rmSync(tmpD, { recursive: true, force: true });
    }
  });
});
