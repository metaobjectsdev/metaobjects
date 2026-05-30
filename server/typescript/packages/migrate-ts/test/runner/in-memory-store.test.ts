// test/runner/in-memory-store.test.ts
import { test, expect, describe } from "bun:test";
import { InMemoryHistoryStore } from "../../src/runner/history-store.js";

function row(version: string, success = true) {
  return { version, name: "x", checksum: "c", appliedAt: "2026-01-01T00:00:00.000Z", executionMs: 1, success };
}

describe("InMemoryHistoryStore", () => {
  test("records, lists sorted, and unrecords", async () => {
    const s = new InMemoryHistoryStore();
    await s.ensure();
    await s.record(row("20260102000000"));
    await s.record(row("20260101000000"));
    expect((await s.applied()).map((r) => r.version)).toEqual(["20260101000000", "20260102000000"]);
    await s.unrecord("20260101000000");
    expect((await s.applied()).map((r) => r.version)).toEqual(["20260102000000"]);
  });
  test("record replaces an existing version", async () => {
    const s = new InMemoryHistoryStore();
    await s.record(row("20260101000000", false));
    await s.record(row("20260101000000", true));
    const rows = await s.applied();
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(true);
  });
  test("lock is exclusive within the instance", async () => {
    const s = new InMemoryHistoryStore();
    await s.acquireLock();
    await expect(s.acquireLock()).rejects.toThrow();
    await s.releaseLock();
    await s.acquireLock(); // ok again
  });
});
