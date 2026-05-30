// test/runner/apply.test.ts
import { test, expect, describe } from "bun:test";
import { applyMigrations, type SqlExecutor } from "../../src/runner/apply.js";
import { InMemoryHistoryStore } from "../../src/runner/history-store.js";
import type { Migration } from "../../src/runner/migration-source.js";

function mig(version: string, up: string, down = ""): Migration {
  return { version, name: `m${version}`, dir: `/tmp/${version}`, upSql: up, downSql: down };
}

class RecordingExecutor implements SqlExecutor {
  ran: string[] = [];
  constructor(private failOn?: string) {}
  async runInTransaction(sql: string): Promise<void> {
    if (this.failOn && sql.includes(this.failOn)) throw new Error("boom");
    this.ran.push(sql);
  }
}

describe("applyMigrations", () => {
  test("applies pending in order, records success, skips already-applied", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [mig("20260101000000", "CREATE A"), mig("20260102000000", "CREATE B")];
    const r1 = await applyMigrations(migs, store, exec);
    expect(r1.applied).toEqual(["20260101000000", "20260102000000"]);
    expect(exec.ran).toEqual(["CREATE A", "CREATE B"]);
    // second run: nothing pending
    const r2 = await applyMigrations(migs, store, exec);
    expect(r2.applied).toEqual([]);
    expect(exec.ran).toEqual(["CREATE A", "CREATE B"]);
  });

  test("dry-run reports pending without executing", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [mig("20260101000000", "CREATE A")];
    const r = await applyMigrations(migs, store, exec, { dryRun: true });
    expect(r.applied).toEqual(["20260101000000"]);
    expect(exec.ran).toEqual([]);
    expect(await store.applied()).toEqual([]); // nothing recorded
  });

  test("on failure: records success=false, stops, does not apply later migrations", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor("CREATE B");
    const migs = [mig("20260101000000", "CREATE A"), mig("20260102000000", "CREATE B"), mig("20260103000000", "CREATE C")];
    await expect(applyMigrations(migs, store, exec)).rejects.toThrow("boom");
    expect(exec.ran).toEqual(["CREATE A"]); // C never attempted
    const rows = await store.applied();
    expect(rows.find((r) => r.version === "20260101000000")?.success).toBe(true);
    expect(rows.find((r) => r.version === "20260102000000")?.success).toBe(false);
    expect(rows.find((r) => r.version === "20260103000000")).toBeUndefined();
  });

  test("releases the lock even on failure", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor("CREATE A");
    await expect(applyMigrations([mig("20260101000000", "CREATE A")], store, exec)).rejects.toThrow();
    // lock must be free now
    await store.acquireLock();
    await store.releaseLock();
  });
});
