// ObjectManager.guardedUpdate — the lifecycle transition's one-statement write (ADR-0066 §6
// step 5), on every bundled PersistenceDriver. The expected answers are SQL's: a row moves only
// when its state is one of `from` and the condition is TRUE, and a comparison with NULL is
// unknown, so a NOT over it is unknown too and matches nothing. The in-memory driver is held to
// the same answers as the two SQL drivers, which is what makes it a usable test double for one.

import { describe, test, expect } from "bun:test";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { MetaDataLoader, InMemoryStringSource, type ExprNode, type MetaRoot } from "@metaobjectsdev/metadata";
import { ObjectManager } from "../src/index.js";
import { inMemoryDriver, kyselyDriver, drizzleDriver } from "../src/drivers/index.js";
import type { PersistenceDriver, Row } from "../src/persistence-driver.js";

// `state` is int-backed (open=0, done=5, closed=9), so every guard symbol must be stored as its
// integer; `kind` is string-backed. amount, cap and note are nullable.
const MODEL = {
  "metadata.root": {
    package: "acme::desk",
    children: [{
      "object.entity": {
        name: "Ticket",
        children: [
          { "source.rdb": { "@table": "tickets" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"] } },
          { "field.enum": { name: "state", "@values": ["open", "done", "closed"], "@intValueMap": { open: 0, done: 5, closed: 9 } } },
          { "field.enum": { name: "kind", "@values": ["bug", "task"] } },
          { "field.int": { name: "amount" } },
          { "field.int": { name: "cap" } },
          { "field.string": { name: "note" } },
        ],
      },
    }],
  },
};

const DDL = `CREATE TABLE tickets (id INTEGER PRIMARY KEY, state INTEGER NOT NULL, kind TEXT NOT NULL,
  amount INTEGER, cap INTEGER, note TEXT)`;

const drzTickets = sqliteTable("tickets", {
  id: integer("id").primaryKey(),
  state: integer("state").notNull(),
  kind: text("kind").notNull(),
  amount: integer("amount"),
  cap: integer("cap"),
  note: text("note"),
});

const SEED: Row[] = [
  { id: 1, state: "open", kind: "bug", amount: 5, cap: 10, note: "hi" },
  { id: 2, state: "open", kind: "task", amount: 20, cap: 10, note: null },
  { id: 3, state: "open", kind: "bug", amount: null, cap: 10, note: null },
  { id: 4, state: "done", kind: "bug", amount: 1, cap: 1, note: "x" },
];

async function loadRoot(): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(JSON.stringify(MODEL), { id: "desk.json" })]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

const DRIVERS: { name: string; build: () => Promise<PersistenceDriver> }[] = [
  { name: "inMemoryDriver", build: async () => inMemoryDriver({ pkFields: { tickets: ["id"] } }) },
  {
    name: "kyselyDriver/sqlite",
    build: async () => {
      const db = new Kysely<Record<string, Row>>({ dialect: new LibsqlDialect({ url: ":memory:" }) });
      await sql.raw(DDL).execute(db);
      return kyselyDriver({ db, dialect: "sqlite" });
    },
  },
  {
    name: "drizzleDriver/sqlite",
    build: async () => {
      const client = createClient({ url: ":memory:" });
      await client.execute(DDL);
      return drizzleDriver({ db: drizzleLibsql(client), schema: { tickets: drzTickets }, dialect: "sqlite" });
    },
  },
  // The MySQL branch (no RETURNING: UPDATE, then read back) over a SQLite connection: it runs the
  // same driver code a MySQL connection would, which is what the read-back-by-key rule is about.
  {
    name: "kyselyDriver/mysql read-back",
    build: async () => {
      const db = new Kysely<Record<string, Row>>({ dialect: new LibsqlDialect({ url: ":memory:" }) });
      await sql.raw(DDL).execute(db);
      return kyselyDriver({ db, dialect: "mysql" });
    },
  },
  {
    name: "drizzleDriver/mysql read-back",
    build: async () => {
      const client = createClient({ url: ":memory:" });
      await client.execute(DDL);
      return drizzleDriver({ db: drizzleLibsql(client), schema: { tickets: drzTickets }, dialect: "mysql" });
    },
  },
];

const gt = (field: string, value: number): ExprNode => ({ op: "gt", left: { field }, right: { value } });

for (const d of DRIVERS) {
  describe(`guardedUpdate on ${d.name}`, () => {
    async function seeded(): Promise<ObjectManager> {
      const om = new ObjectManager({ metadata: await loadRoot(), driver: await d.build() });
      for (const row of SEED) await om.create("Ticket", row);
      return om;
    }
    const stateOf = async (om: ObjectManager, id: number) => (await om.findById("Ticket", id))?.["state"];

    test("moves a row in a from-state, and the second move out of that state matches nothing", async () => {
      const om = await seeded();
      const moved = await om.guardedUpdate("Ticket", 1, { field: "state", from: ["open"], to: "done" });
      expect(moved?.["state"]).toBe("done");
      expect(await om.guardedUpdate("Ticket", 1, { field: "state", from: ["open"], to: "closed" })).toBeNull();
      expect(await stateOf(om, 1)).toBe("done");
    });

    test("a row in no from-state, and a missing row, match nothing and nothing is written", async () => {
      const om = await seeded();
      expect(await om.guardedUpdate("Ticket", 4, { field: "state", from: ["open"], to: "closed" })).toBeNull();
      expect(await om.guardedUpdate("Ticket", 99, { field: "state", from: ["open"], to: "closed" })).toBeNull();
      expect(await stateOf(om, 4)).toBe("done");
      expect((await om.guardedUpdate("Ticket", 4, { field: "state", from: ["open", "done"], to: "closed" }))?.["state"]).toBe("closed");
    });

    test("a column compared with a column", async () => {
      const om = await seeded();
      const withinCap: ExprNode = { op: "lte", left: { field: "amount" }, right: { field: "cap" } };
      expect(await om.guardedUpdate("Ticket", 2, { field: "state", from: ["open"], to: "done", condition: withinCap })).toBeNull();
      expect((await om.guardedUpdate("Ticket", 1, { field: "state", from: ["open"], to: "done", condition: withinCap }))?.["state"]).toBe("done");
    });

    test("NOT over a comparison with NULL is unknown and matches nothing (SQL three-valued logic)", async () => {
      const om = await seeded();
      // Ticket 3's amount is NULL: `amount > 10` is unknown, and so is NOT of it.
      const notLarge: ExprNode = { op: "not", arg: gt("amount", 10) };
      expect(await om.guardedUpdate("Ticket", 3, { field: "state", from: ["open"], to: "done", condition: notLarge })).toBeNull();
      expect(await stateOf(om, 3)).toBe("open");
      expect((await om.guardedUpdate("Ticket", 1, { field: "state", from: ["open"], to: "done", condition: notLarge }))?.["state"]).toBe("done");
    });

    test("null tests, coalesce, or, and literals compared with enum fields in their stored form", async () => {
      const om = await seeded();
      const cond: ExprNode = {
        op: "and",
        args: [
          { op: "eq", left: { fn: "coalesce", args: [{ field: "note" }, { value: "none" }] }, right: { value: "none" } },
          { op: "or", args: [gt("amount", 100), { op: "isNotNull", arg: { field: "amount" } }] },
          { op: "ne", left: { field: "state" }, right: { value: "closed" } },
          { op: "eq", left: { field: "kind" }, right: { value: "task" } },
        ],
      } as ExprNode;
      expect((await om.guardedUpdate("Ticket", 2, { field: "state", from: ["open"], to: "closed", condition: cond }))?.["state"]).toBe("closed");
      // Ticket 3 fails `kind = task` and the null test; ticket 1 fails the coalesce.
      expect(await om.guardedUpdate("Ticket", 3, { field: "state", from: ["open"], to: "closed", condition: cond })).toBeNull();
      expect(await om.guardedUpdate("Ticket", 1, { field: "state", from: ["open"], to: "closed", condition: cond })).toBeNull();
      expect(await om.count("Ticket", { state: "closed" })).toBe(1);
    });

    test("a condition outside the @condition grammar, and a to-state that is not a member, are refused", async () => {
      const om = await seeded();
      const relative = { op: "gt", left: { field: "amount" }, right: { now: "-P1D" } } as unknown as ExprNode;
      await expect(om.guardedUpdate("Ticket", 1, { field: "state", from: ["open"], to: "done", condition: relative })).rejects.toThrow(/not an operand/);
      await expect(om.guardedUpdate("Ticket", 1, { field: "state", from: ["open"], to: "shipped" })).rejects.toThrow();
      await expect(om.guardedUpdate("Ticket", 1, { field: "state", from: [], to: "done" })).rejects.toThrow(/names no state/);
      expect(await stateOf(om, 1)).toBe("open");
    });
  });
}
