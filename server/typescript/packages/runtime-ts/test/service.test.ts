// The store mechanics a generated service calls (`@metaobjectsdev/runtime-ts/service`, ADR-0067
// layer 4): one transaction per write, a savepoint inside a caller's, a refusal that rolls back,
// and the failures the REST contract gives a status.
//
// libsql on a scratch file: drizzle's libsql driver runs an async transaction, and an in-memory
// libsql database would hand the transaction a connection of its own with no tables in it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  deleteRows,
  inReadScope,
  insertRow,
  inWriteTransaction,
  keyCondition,
  listRows,
  loadForWrite,
  notFound,
  refuse,
  updateRow,
  validateBody,
  type OpResult,
} from "../src/service/index.js";
import { RedactedDatabaseError } from "../src/constraint-errors.js";

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  secret: text("secret"),
});
const InsertSchema = z.object({ id: z.number().int().optional(), title: z.string().min(1), secret: z.string().optional() });
const allowlist = { title: { ops: ["eq", "like"], kind: "string", leadingWildcard: false } } as never;
const sortAllowlist = { title: true } as never;

let dir: string;
let client: Client;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  dir = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "runtime-ts-service-"));
  client = createClient({ url: `file:${join(dir, "service.db")}` });
  db = drizzle(client);
  await client.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, secret TEXT)");
});

afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute("DELETE FROM notes");
  // AUTOINCREMENT keeps its counter across a DELETE; each test starts its keys at 1.
  await client.execute("DELETE FROM sqlite_sequence WHERE name = 'notes'");
});

async function titles(): Promise<string[]> {
  return (await client.execute("SELECT title FROM notes ORDER BY id")).rows.map((r) => String(r["title"]));
}

function failed<T>(r: OpResult<T>): { status: number; error: Record<string, unknown> } {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.value)}`);
  return r;
}

describe("inWriteTransaction", () => {
  test("a write commits and answers its value", async () => {
    const r = await inWriteTransaction(db, undefined, (tx) => insertRow(tx, notes, { title: "a" }, "sqlite"));
    expect(r).toEqual({ ok: true, value: { id: 1, title: "a", secret: null } });
    expect(await titles()).toEqual(["a"]);
  });

  test("a refusal rolls back every write the operation made and answers 409 with its body", async () => {
    const r = await inWriteTransaction(db, undefined, async (tx) => {
      await insertRow(tx, notes, { title: "written, then undone" }, "sqlite");
      refuse({ error: "not_allowed", reason: "closed" });
    });
    expect(failed(r)).toEqual({ ok: false, status: 409, error: { error: "not_allowed", reason: "closed" } } as never);
    expect(await titles()).toEqual([]);
  });

  test("inside a caller's transaction a refusal undoes this operation only (a savepoint)", async () => {
    await db.transaction(async (outer) => {
      await insertRow(outer, notes, { title: "the caller's" }, "sqlite");
      const r = await inWriteTransaction(db, outer, async (tx) => {
        await insertRow(tx, notes, { title: "the operation's" }, "sqlite");
        notFound();
      });
      expect(failed(r).status).toBe(404);
    });
    expect(await titles()).toEqual(["the caller's"]);
  });

  test("a constraint the database refuses answers the contract's constraint_violation", async () => {
    await insertRow(db, notes, { id: 7, title: "first" }, "sqlite");
    const r = await inWriteTransaction(db, undefined, (tx) => insertRow(tx, notes, { id: 7, title: "again" }, "sqlite"));
    const f = failed(r);
    expect(f.status).toBe(409);
    expect(f.error.error).toBe("constraint_violation");
  });

  test("any other failure is rethrown redacted, with no SQL in it", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const bogus = sqliteTable("no_such_table", { id: integer("id").primaryKey() });
      await expect(inWriteTransaction(db, undefined, (tx) => insertRow(tx, bogus, { id: 1 }, "sqlite"))).rejects.toBeInstanceOf(
        RedactedDatabaseError,
      );
    } finally {
      console.error = quiet;
    }
  });
});

describe("validateBody", () => {
  const rules = { knownFields: ["id", "title", "secret"], writeDeniedColumns: ["secret"] };

  test("an unknown key is refused with unknown_fields, naming it", async () => {
    const r = await inWriteTransaction(db, undefined, async () => validateBody(InsertSchema, { title: "a", colour: "red" }, rules));
    expect(failed(r)).toEqual({ ok: false, status: 400, error: { error: "unknown_fields", fields: ["colour"] } } as never);
  });

  test("a schema failure is refused with validation", async () => {
    const r = await inWriteTransaction(db, undefined, async () => validateBody(InsertSchema, { title: "" }, rules));
    const f = failed(r);
    expect(f.status).toBe(400);
    expect(f.error.error).toBe("validation");
  });

  test("a write-denied key is dropped, not written", () => {
    expect(validateBody(InsertSchema, { title: "a", secret: "s" }, rules)).toEqual({ title: "a" });
  });

  test("with no known-field list an unknown key is dropped by the schema", () => {
    expect(validateBody(InsertSchema, { title: "a", colour: "red" }, {})).toEqual({ title: "a" });
  });
});

describe("keyCondition, loadForWrite, updateRow and deleteRows", () => {
  test("an id that is no key of the column is refused with invalid_id", async () => {
    const r = await inReadScope(db, undefined, async () => keyCondition(notes, "id", "0x1"));
    expect(failed(r)).toEqual({ ok: false, status: 400, error: { error: "invalid_id" } } as never);
  });

  test("update and delete address the row the key names", async () => {
    await insertRow(db, notes, { title: "a" }, "sqlite");
    await insertRow(db, notes, { title: "b" }, "sqlite");
    const r = await inWriteTransaction(db, undefined, async (tx) => {
      const cond = keyCondition(notes, "id", "2");
      expect(await loadForWrite(tx, notes, cond, "sqlite")).toEqual({ id: 2, title: "b", secret: null });
      return updateRow(tx, notes, { title: "B" }, cond, "sqlite");
    });
    expect(r).toEqual({ ok: true, value: { id: 2, title: "B", secret: null } });
    expect(await deleteRows(db, notes, keyCondition(notes, "id", 1))).toBe(1);
    expect(await titles()).toEqual(["B"]);
  });
});

describe("listRows", () => {
  const spec = { filterAllowlist: allowlist, sortAllowlist, dialect: "sqlite" as const };

  beforeEach(async () => {
    for (const title of ["c", "a", "b"]) await insertRow(db, notes, { title }, "sqlite");
  });

  test("with no sort the page is ordered by the key", async () => {
    const r = await inReadScope(db, undefined, (d) => listRows(d, notes, {}, spec));
    expect(r.ok && r.value.rows.map((row) => row.title)).toEqual(["c", "a", "b"]);
    expect(r.ok && r.value.total).toBeUndefined();
  });

  test("a filter, a sort, a page and the count", async () => {
    const r = await inReadScope(db, undefined, (d) =>
      listRows(d, notes, { filter: { title: { like: "_" } }, sort: "title:desc", limit: "2", withCount: "1" }, spec),
    );
    expect(r.ok && r.value).toEqual({
      rows: [
        { id: 1, title: "c", secret: null },
        { id: 3, title: "b", secret: null },
      ],
      total: 3,
    });
  });

  test("a field off the allowlist is refused as the REST contract refuses it", async () => {
    const r = await inReadScope(db, undefined, (d) => listRows(d, notes, { filter: { secret: "x" } }, spec));
    const f = failed(r);
    expect(f.status).toBe(400);
    expect(f.error.error).toBe("invalid_filter_field");
  });
});
