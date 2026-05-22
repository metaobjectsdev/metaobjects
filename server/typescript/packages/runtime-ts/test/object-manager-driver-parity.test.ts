// Driver-parity test: same suite runs against all three drivers.
// Asserts identical observable behavior — the contract enforcement
// for the PersistenceDriver abstraction.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { newDb } from "pg-mem";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { FileMetaDataLoader } from "@metaobjectsdev/metadata/core";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ObjectManager } from "../src/index.js";
import { inMemoryDriver, kyselyDriver, drizzleDriver } from "../src/drivers/index.js";
import { TWO_ENTITIES_FK_SQLITE, TWO_ENTITIES_FK_POSTGRES, splitStatements } from "./fixtures/setup-sql.js";
import type { PersistenceDriver, Row } from "../src/persistence-driver.js";

// Drizzle schema mirroring TWO_ENTITIES_FK_SQLITE — used by the drizzle-driver fixture.
const drzUsers = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
});
const drzPosts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  authorId: integer("author_id")
    .notNull()
    .references(() => drzUsers.id),
});
const DRIZZLE_SCHEMA = { users: drzUsers, posts: drzPosts };

const FIXTURE = resolve(import.meta.dir, "fixtures/two-entities-fk.json");

interface DriverFixture {
  name: string;
  build: () => Promise<{ driver: PersistenceDriver; teardown: () => Promise<void> }>;
  /** pg-mem's Kysely adapter does not honor transaction rollback semantics. */
  supportsTransactions?: boolean;
}

const DRIVERS: DriverFixture[] = [
  {
    name: "inMemoryDriver",
    supportsTransactions: true,
    build: async () => {
      const driver = inMemoryDriver({ pkFields: { users: ["id"], posts: ["id"] } });
      return { driver, teardown: async () => {} };
    },
  },
  {
    name: "kyselyDriver/libsql-sqlite",
    supportsTransactions: true,
    build: async () => {
      // libsql clears its internal connection after a transaction; with bare `:memory:`
      // the next op opens a fresh empty DB. libsql only accepts `cache` as in-memory
      // URL param (rejects `mode=memory`). A tmp file gives proper persistence + isolation.
      const dir = mkdtempSync(join(tmpdir(), "libsql-parity-"));
      const dbPath = join(dir, "test.db");
      const db = new Kysely<Record<string, Row>>({ dialect: new LibsqlDialect({ url: `file:${dbPath}` }) });
      for (const stmt of splitStatements(TWO_ENTITIES_FK_SQLITE)) {
        await sql.raw(stmt).execute(db);
      }
      const driver = kyselyDriver({ db, dialect: "sqlite" });
      return {
        driver,
        teardown: async () => {
          await db.destroy();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: "kyselyDriver/pg-mem-postgres",
    build: async () => {
      const mem = newDb();
      // pg-mem's createKysely() already returns a fully-built Kysely instance.
      const db = mem.adapters.createKysely() as Kysely<Record<string, Row>>;
      for (const stmt of splitStatements(TWO_ENTITIES_FK_POSTGRES)) {
        await sql.raw(stmt).execute(db);
      }
      const driver = kyselyDriver({ db, dialect: "postgres" });
      return { driver, teardown: async () => { await db.destroy(); } };
    },
  },
  {
    name: "drizzleDriver/libsql-sqlite",
    supportsTransactions: true,
    build: async () => {
      // Same tmpfile pattern as the Kysely-libsql fixture; bare `:memory:` resets
      // between transactions, so a file path is needed for proper persistence.
      const dir = mkdtempSync(join(tmpdir(), "drizzle-parity-"));
      const dbPath = join(dir, "test.db");
      const client = createClient({ url: `file:${dbPath}` });
      const db = drizzleLibsql(client, { schema: DRIZZLE_SCHEMA });
      // Create tables via the underlying libsql client (Drizzle's migrator is overkill for tests).
      for (const stmt of splitStatements(TWO_ENTITIES_FK_SQLITE)) {
        await client.execute(stmt);
      }
      const driver = drizzleDriver({ db, schema: DRIZZLE_SCHEMA, dialect: "sqlite" });
      return {
        driver,
        teardown: async () => {
          client.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

for (const { name, build, supportsTransactions } of DRIVERS) {
  describe(`driver-parity — ${name}`, () => {
    let teardown: () => Promise<void>;
    let om: ObjectManager;

    beforeEach(async () => {
      const built = await build();
      teardown = built.teardown;
      const loader = new FileMetaDataLoader();
      const result = await loader.loadFiles([FIXTURE]);
      expect(result.errors).toEqual([]);
      om = new ObjectManager({ metadata: result.root, driver: built.driver });
    });

    afterEach(async () => { await teardown(); });

    test("create + findById round-trip", async () => {
      const user = await om.create("User", { email: "x@y" });
      const found = await om.findById("User", user.id);
      expect(found?.email).toBe("x@y");
    });

    test("create with FK + findById include", async () => {
      const user = await om.create("User", { email: "x@y" });
      const post = await om.create("Post", { title: "p", authorId: user.id });
      const got = await om.findById("Post", post.id, { include: ["author"] });
      expect((got!.author as Row).email).toBe("x@y");
    });

    test("findMany with filter + count", async () => {
      const u = await om.create("User", { email: "u@y" });
      await om.create("Post", { title: "p1", authorId: u.id });
      await om.create("Post", { title: "p2", authorId: u.id });
      const posts = await om.findMany("Post", { authorId: u.id as number });
      expect(posts).toHaveLength(2);
      expect(await om.count("Post", { authorId: u.id as number })).toBe(2);
    });

    test("update + delete", async () => {
      const u = await om.create("User", { email: "u@y" });
      const u2 = await om.update("User", u.id, { email: "z@y" });
      expect(u2?.email).toBe("z@y");
      expect(await om.delete("User", u.id)).toBe(true);
      expect(await om.findById("User", u.id)).toBeNull();
    });

    // pg-mem's Kysely adapter does not propagate ROLLBACK; skip the rollback assertion there.
    (supportsTransactions ? test : test.skip)("transaction rollback on throw", async () => {
      const before = await om.count("User");
      await expect(om.transaction(async (tx) => {
        await tx.create("User", { email: "tx@y" });
        throw new Error("boom");
      })).rejects.toThrow("boom");
      expect(await om.count("User")).toBe(before);
    });
  });
}
