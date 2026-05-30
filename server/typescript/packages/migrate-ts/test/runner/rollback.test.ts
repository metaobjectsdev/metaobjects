// test/runner/rollback.test.ts
import { test, expect, describe } from "bun:test";
import { applyMigrations, rollbackTo, type SqlExecutor } from "../../src/runner/apply.js";
import { InMemoryHistoryStore } from "../../src/runner/history-store.js";
import type { Migration } from "../../src/runner/migration-source.js";

function mig(version: string, up: string, down: string): Migration {
  return { version, name: `m${version}`, dir: `/tmp/${version}`, upSql: up, downSql: down };
}
class RecordingExecutor implements SqlExecutor {
  ran: string[] = [];
  async runInTransaction(sql: string): Promise<void> { this.ran.push(sql); }
}

describe("rollbackTo", () => {
  test("rolls back newer-than-target in reverse order and unrecords", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [
      mig("20260101000000", "CREATE A", "DROP A"),
      mig("20260102000000", "CREATE B", "DROP B"),
      mig("20260103000000", "CREATE C", "DROP C"),
    ];
    await applyMigrations(migs, store, exec);
    exec.ran = [];
    const r = await rollbackTo("20260101000000", migs, store, exec);
    expect(r.rolledBack).toEqual(["20260103000000", "20260102000000"]); // reverse
    expect(exec.ran).toEqual(["DROP C", "DROP B"]);
    expect((await store.applied()).map((x) => x.version)).toEqual(["20260101000000"]);
  });

  test("target null rolls everything back", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [mig("20260101000000", "CREATE A", "DROP A")];
    await applyMigrations(migs, store, exec);
    const r = await rollbackTo(null, migs, store, exec);
    expect(r.rolledBack).toEqual(["20260101000000"]);
    expect(await store.applied()).toEqual([]);
  });

  test("throws when down.sql is empty", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [mig("20260101000000", "CREATE A", "")];
    await applyMigrations(migs, store, exec);
    await expect(rollbackTo(null, migs, store, exec)).rejects.toThrow(/down\.sql is empty/);
  });
});
