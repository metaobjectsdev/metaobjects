// The runtime pillar on MySQL: ObjectManager over the Kysely driver (MysqlDialect + mysql2)
// and over the Drizzle driver (drizzle-orm/mysql2, with the `dialect: "mysql"` generated
// tables as its schema), against a real MySQL 8.4 server.
//
// MySQL has no RETURNING, so each driver writes and reads the row back: an AUTO_INCREMENT
// key comes from the server's insertId, an app-minted uuid key from the written values.
// MetaObjects does not own a MySQL schema, so the DDL is hand-written.
//
// Requires Docker (or METAOBJECTS_TEST_MYSQL_URL).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kysely, MysqlDialect } from "kysely";
import mysql from "mysql2/promise";
import { createPool } from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { defineConfig, runGen } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/test-generators";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import {
  ObjectManager, ConstraintViolationError, type PersistenceDriver, type Row,
} from "@metaobjectsdev/runtime-ts";
import { kyselyDriver, drizzleDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { startMysql, type MysqlContainerHandle } from "../src/mysql-container.ts";

const MODEL = {
  "metadata.root": {
    package: "library",
    children: [
      {
        "object.entity": {
          name: "Author",
          children: [
            { "source.rdb": { "@table": "authors" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@required": true, "@maxLength": 100 } },
            { "field.string": { name: "email", "@required": true, "@maxLength": 200 } },
            { "field.boolean": { name: "active", "@required": true } },
            { "field.timestamp": { name: "joinedAt" } },
            { "field.string": { name: "tags", isArray: true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.secondary": { name: "byEmail", "@fields": ["email"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Book",
          children: [
            { "source.rdb": { "@table": "books" } },
            { "field.uuid": { name: "id" } },
            { "field.string": { name: "title", "@required": true, "@maxLength": 200 } },
            { "field.long": { name: "authorId", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "uuid" } },
            { "identity.reference": { name: "fkAuthor", "@fields": ["authorId"], "@references": "Author" } },
          ],
        },
      },
    ],
  },
};

const DDL = [
  "DROP TABLE IF EXISTS books",
  "DROP TABLE IF EXISTS authors",
  `CREATE TABLE authors (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(100) NOT NULL,
     email VARCHAR(200) NOT NULL,
     active BOOLEAN NOT NULL,
     joined_at DATETIME(3),
     tags JSON,
     UNIQUE KEY byEmail (email)
   )`,
  `CREATE TABLE books (
     id VARCHAR(36) PRIMARY KEY,
     title VARCHAR(200) NOT NULL,
     author_id BIGINT NOT NULL,
     CONSTRAINT fk_books_author FOREIGN KEY (author_id) REFERENCES authors (id)
   )`,
];

let container: MysqlContainerHandle;
let admin: mysql.Connection;
let metadata: MetaRoot;
let tmp = "";
let schema: Record<string, unknown> = {};

beforeAll(async () => {
  container = await startMysql();
  admin = await mysql.createConnection(container.url);

  const here = dirname(fileURLToPath(import.meta.url));
  const genRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genRoot, { recursive: true });
  tmp = mkdtempSync(join(genRoot, "mysql-om-"));
  const metaPath = join(tmp, "meta.library.json");
  writeFileSync(metaPath, JSON.stringify(MODEL));
  metadata = await loadMetadataFile(metaPath);

  // The Drizzle driver's schema is the generated `dialect: "mysql"` tables.
  await runGen({
    config: defineConfig({ outDir: tmp, extStyle: "none", dialect: "mysql", generators: [entityFile({ allowlists: false })] }),
    metadata,
  });
  schema = {
    ...(await import(pathToFileURL(join(tmp, "Author.ts")).href)),
    ...(await import(pathToFileURL(join(tmp, "Book.ts")).href)),
  };
}, 240_000);

afterAll(async () => {
  await admin?.end();
  container?.stop();
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

const DRIVERS: Array<{ name: string; build: () => { driver: PersistenceDriver; close: () => Promise<void> } }> = [
  {
    name: "kyselyDriver (MysqlDialect)",
    build: () => {
      const db = new Kysely<Record<string, Row>>({
        dialect: new MysqlDialect({ pool: createPool({ uri: container.url, timezone: "Z" }) }),
      });
      return { driver: kyselyDriver({ db, dialect: "mysql" }), close: () => db.destroy() };
    },
  },
  {
    name: "drizzleDriver (mysql2)",
    build: () => {
      const pool = createPool({ uri: container.url, timezone: "Z" });
      const db = drizzle(pool);
      return {
        driver: drizzleDriver({ db, schema, dialect: "mysql" }),
        close: () => new Promise<void>((resolve) => pool.end(() => resolve())),
      };
    },
  },
];

for (const { name, build } of DRIVERS) {
  describe(`ObjectManager on MySQL — ${name}`, () => {
    test("create reads the AUTO_INCREMENT key back; types round-trip; update, delete, missing rows", async () => {
      for (const stmt of DDL) await admin.query(stmt);
      const { driver, close } = build();
      try {
        const om = new ObjectManager({ metadata, driver });
        const joinedAt = "2026-05-28T20:26:40.002Z";
        const a = await om.create("Author", {
          name: "Alice", email: "alice@example.com", active: true, joinedAt, tags: ["x", "y"],
        });
        expect(typeof a.id).toBe("number");
        expect(a.active).toBe(true);
        expect(a.tags).toEqual(["x", "y"]);
        expect(new Date(a.joinedAt as string | Date).toISOString()).toBe(joinedAt);

        // The DATETIME holds the UTC wall clock (pool timezone "Z").
        const [rows] = await admin.query("SELECT DATE_FORMAT(joined_at, '%Y-%m-%dT%H:%i:%s.%f') AS j FROM authors WHERE id = ?", [a.id]);
        expect(`${(rows as Array<{ j: string }>)[0]!.j.slice(0, 23)}Z`).toBe(joinedAt);

        const b = await om.create("Book", { title: "Poems", authorId: a.id });
        expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
        expect((await om.findById("Book", b.id))?.title).toBe("Poems");

        const many = await om.createMany("Author", [
          { name: "Bob", email: "bob@example.com", active: false },
          { name: "Cy", email: "cy@example.com", active: true },
        ]);
        expect(many.map((r) => r.name)).toEqual(["Bob", "Cy"]);
        expect(many[0]!.active).toBe(false);
        expect(await om.count("Author")).toBe(3);

        const updated = await om.update("Author", a.id, { name: "Alicia", active: false });
        expect(updated).toMatchObject({ id: a.id, name: "Alicia", active: false });
        expect(await om.update("Author", 999999, { name: "x" }, { ifMissing: "ignore" })).toBeNull();

        expect(await om.delete("Book", b.id)).toBe(true);
        expect(await om.delete("Book", b.id, { ifMissing: "ignore" })).toBe(false);
      } finally {
        await close();
      }
    });

    test("unique and foreign-key violations surface as ConstraintViolationError", async () => {
      for (const stmt of DDL) await admin.query(stmt);
      const { driver, close } = build();
      try {
        const om = new ObjectManager({ metadata, driver });
        await om.create("Author", { name: "Dan", email: "dan@example.com", active: true });
        const dup = await om.create("Author", { name: "Dan2", email: "dan@example.com", active: true }).catch((e) => e);
        expect(dup).toBeInstanceOf(ConstraintViolationError);
        expect((dup as ConstraintViolationError).kind).toBe("unique");

        const orphan = await om.create("Book", { title: "Orphan", authorId: 424242 }).catch((e) => e);
        expect(orphan).toBeInstanceOf(ConstraintViolationError);
        expect((orphan as ConstraintViolationError).kind).toBe("foreign_key");
      } finally {
        await close();
      }
    });
  });
}
