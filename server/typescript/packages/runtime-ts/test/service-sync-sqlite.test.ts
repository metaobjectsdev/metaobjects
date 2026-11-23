// A generated service's write transaction on a SYNC SQLite driver (`bun:sqlite`; `better-sqlite3`
// is the same Drizzle session kind). Drizzle's own `transaction()` there runs its callback
// synchronously and commits when it returns, so an operation that awaits inside it would commit at
// its first `await` and a refusal after that would roll nothing back. The service drives the
// transaction with statements instead; these tests hold it to what every other driver answers.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  inReadScope,
  insertRow,
  inWriteTransaction,
  refuse,
  withWriteTransaction,
  type OpResult,
} from "../src/service/index.js";

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
});

let sqlite: Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)");
  db = drizzle(sqlite);
});

afterEach(() => sqlite.close());

const titles = (): string[] => (sqlite.query("SELECT title FROM notes ORDER BY id").all() as { title: string }[]).map((r) => r.title);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function failed<T>(r: OpResult<T>): { status: number; error: Record<string, unknown> } {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.value)}`);
  return r;
}

describe("inWriteTransaction on a sync SQLite driver", () => {
  test("a write commits and answers its value", async () => {
    const r = await inWriteTransaction(db, undefined, (tx) => insertRow(tx, notes, { title: "a" }, "sqlite"));
    expect(r).toEqual({ ok: true, value: { id: 1, title: "a" } });
    expect(titles()).toEqual(["a"]);
  });

  test("a refusal after an await undoes the write made before it", async () => {
    // The defect this guards: with Drizzle's sync transaction() the insert below was committed at
    // the `await`, and the refusal answered 409 over a row that stayed.
    const r = await inWriteTransaction(db, undefined, async (tx) => {
      await insertRow(tx, notes, { title: "written, then undone" }, "sqlite");
      await tick();
      refuse({ error: "not_allowed" });
    });
    expect(failed(r)).toEqual({ ok: false, status: 409, error: { error: "not_allowed" } } as never);
    expect(titles()).toEqual([]);
  });

  test("two operations at once do not interleave: one's rollback leaves the other's row", async () => {
    const [kept, undone] = await Promise.all([
      inWriteTransaction(db, undefined, async (tx) => {
        await tick();
        return insertRow(tx, notes, { title: "kept" }, "sqlite");
      }),
      inWriteTransaction(db, undefined, async (tx) => {
        await insertRow(tx, notes, { title: "undone" }, "sqlite");
        await tick();
        refuse({ error: "not_allowed" });
      }),
    ]);
    expect(kept.ok).toBe(true);
    expect(failed(undone).status).toBe(409);
    expect(titles()).toEqual(["kept"]);
  });

  test("a read waits for the transaction in flight, so it never sees a write that rolls back", async () => {
    const write = inWriteTransaction(db, undefined, async (tx) => {
      await insertRow(tx, notes, { title: "never committed" }, "sqlite");
      await tick();
      refuse({ error: "not_allowed" });
    });
    const read = inReadScope(db, undefined, async (rd) => (await rd.select().from(notes)).length);
    await write;
    expect(await read).toEqual({ ok: true, value: 0 });
  });

  test("inside a caller's transaction a refusal undoes this operation only, and the caller's commit keeps the rest", async () => {
    await withWriteTransaction(db, async (outer) => {
      await insertRow(outer, notes, { title: "the caller's" }, "sqlite");
      const r = await inWriteTransaction(db, outer, async (tx) => {
        await insertRow(tx, notes, { title: "the operation's" }, "sqlite");
        await tick();
        refuse({ error: "not_allowed" });
      });
      expect(failed(r).status).toBe(409);
    });
    expect(titles()).toEqual(["the caller's"]);
  });

  test("a throw in the caller's transaction undoes every operation that ran inside it", async () => {
    await expect(
      withWriteTransaction(db, async (outer) => {
        const r = await inWriteTransaction(db, outer, (tx) => insertRow(tx, notes, { title: "inside" }, "sqlite"));
        expect(r.ok).toBe(true);
        await tick();
        throw new Error("the job failed");
      }),
    ).rejects.toThrow("the job failed");
    expect(titles()).toEqual([]);
  });
});
