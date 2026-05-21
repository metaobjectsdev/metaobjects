import { describe, test, expect, beforeEach } from "bun:test";
import { inMemoryDriver } from "../../src/drivers/in-memory-driver.js";
import { ConstraintViolationError } from "../../src/errors.js";
import type { PersistenceDriver } from "../../src/persistence-driver.js";

let driver: PersistenceDriver;

beforeEach(() => {
  driver = inMemoryDriver({
    seed: {
      posts: [
        { id: 1, title: "Hello", author_id: 10 },
        { id: 2, title: "World", author_id: 11 },
      ],
      users: [
        { id: 10, email: "a@x" },
        { id: 11, email: "b@x" },
      ],
    },
    pkFields: { posts: ["id"], users: ["id"] },
  });
});

describe("inMemoryDriver — selectOne / selectMany", () => {
  test("selectOne by eq", async () => {
    const row = await driver.selectOne({
      table: "posts", columns: ["id", "title"],
      where: { kind: "eq", column: "id", value: 1 },
    });
    expect(row).toEqual({ id: 1, title: "Hello" });
  });

  test("selectOne with no match → null", async () => {
    const row = await driver.selectOne({
      table: "posts", columns: ["id"],
      where: { kind: "eq", column: "id", value: 999 },
    });
    expect(row).toBeNull();
  });

  test("selectMany with no filter returns all rows (projected columns)", async () => {
    const rows = await driver.selectMany({ table: "posts", columns: ["id", "title"] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 1, title: "Hello" });
  });

  test("selectMany with IN(...)", async () => {
    const rows = await driver.selectMany({
      table: "posts", columns: ["id"],
      where: { kind: "in", column: "id", values: [1, 2, 999] },
    });
    expect(rows).toHaveLength(2);
  });

  test("selectMany with limit + offset + orderBy", async () => {
    const rows = await driver.selectMany({
      table: "posts", columns: ["id"],
      orderBy: [{ column: "id", direction: "desc" }],
      limit: 1, offset: 0,
    });
    expect(rows[0]?.id).toBe(2);
  });
});

describe("inMemoryDriver — count", () => {
  test("with filter", async () => {
    const n = await driver.count({
      table: "posts", where: { kind: "eq", column: "author_id", value: 10 },
    });
    expect(n).toBe(1);
  });

  test("no filter", async () => {
    expect(await driver.count({ table: "posts" })).toBe(2);
  });
});

describe("inMemoryDriver — insert", () => {
  test("with explicit PK", async () => {
    const row = await driver.insert({
      table: "posts", values: { id: 3, title: "New", author_id: 10 }, returning: ["id", "title"],
    });
    expect(row).toEqual({ id: 3, title: "New" });
    expect(await driver.count({ table: "posts" })).toBe(3);
  });

  test("auto-increment when id missing", async () => {
    const row = await driver.insert({
      table: "posts", values: { title: "Auto", author_id: 10 }, returning: ["id", "title"],
    });
    expect(typeof row.id).toBe("number");
    expect(Number(row.id)).toBeGreaterThanOrEqual(3);
  });

  test("PK collision → ConstraintViolationError", async () => {
    await expect(driver.insert({
      table: "posts", values: { id: 1, title: "dup", author_id: 10 }, returning: ["id"],
    })).rejects.toThrow(ConstraintViolationError);
  });
});

describe("inMemoryDriver — update", () => {
  test("update by eq returns updated row with returning columns", async () => {
    const row = await driver.update({
      table: "posts", values: { title: "Updated" },
      where: { kind: "eq", column: "id", value: 1 },
      returning: ["id", "title"],
    });
    expect(row).toEqual({ id: 1, title: "Updated" });
  });

  test("update non-matching → null", async () => {
    const row = await driver.update({
      table: "posts", values: { title: "x" },
      where: { kind: "eq", column: "id", value: 999 },
      returning: ["id"],
    });
    expect(row).toBeNull();
  });

  test("updateMany returns count", async () => {
    const n = await driver.updateMany({
      table: "posts", values: { title: "all" },
      where: { kind: "in", column: "id", values: [1, 2] },
    });
    expect(n).toBe(2);
  });
});

describe("inMemoryDriver — delete", () => {
  test("delete by eq returns 1", async () => {
    const n = await driver.delete({
      table: "posts", where: { kind: "eq", column: "id", value: 1 },
    });
    expect(n).toBe(1);
    expect(await driver.count({ table: "posts" })).toBe(1);
  });

  test("delete non-matching → 0", async () => {
    expect(await driver.delete({
      table: "posts", where: { kind: "eq", column: "id", value: 999 },
    })).toBe(0);
  });

  test("deleteMany", async () => {
    const n = await driver.deleteMany({
      table: "posts", where: { kind: "in", column: "id", values: [1, 2] },
    });
    expect(n).toBe(2);
  });
});

describe("inMemoryDriver — transactions", () => {
  test("commit on resolve", async () => {
    await driver.transaction(async (tx) => {
      await tx.insert({ table: "posts", values: { id: 99, title: "tx", author_id: 10 }, returning: ["id"] });
    });
    expect(await driver.count({ table: "posts" })).toBe(3);
  });

  test("rollback on throw", async () => {
    await expect(driver.transaction(async (tx) => {
      await tx.insert({ table: "posts", values: { id: 99, title: "tx", author_id: 10 }, returning: ["id"] });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await driver.count({ table: "posts" })).toBe(2);
  });

  test("nested transactions: inner rollback doesn't break outer", async () => {
    await driver.transaction(async (outerTx) => {
      await outerTx.insert({ table: "posts", values: { id: 50, title: "o", author_id: 10 }, returning: ["id"] });
      try {
        await outerTx.transaction(async (innerTx) => {
          await innerTx.insert({ table: "posts", values: { id: 51, title: "i", author_id: 10 }, returning: ["id"] });
          throw new Error("inner");
        });
      } catch {}
    });
    // Outer (id=50) committed; inner (id=51) rolled back
    expect(await driver.count({ table: "posts", where: { kind: "eq", column: "id", value: 50 } })).toBe(1);
    expect(await driver.count({ table: "posts", where: { kind: "eq", column: "id", value: 51 } })).toBe(0);
  });
});

describe("inMemoryDriver — where clause variants", () => {
  test("ne", async () => {
    const rows = await driver.selectMany({
      table: "posts", columns: ["id"],
      where: { kind: "ne", column: "id", value: 1 },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(2);
  });

  test("gt / lt", async () => {
    expect((await driver.selectMany({
      table: "posts", columns: ["id"],
      where: { kind: "gt", column: "id", value: 1 },
    })).map((r) => r.id)).toEqual([2]);
  });

  test("like (case-sensitive % wildcard)", async () => {
    const rows = await driver.selectMany({
      table: "posts", columns: ["id", "title"],
      where: { kind: "like", column: "title", pattern: "Hel%" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Hello");
  });

  test("like with regex-special literals (* and ?) treated as ordinary chars", async () => {
    await driver.insert({ table: "posts", values: { id: 6, title: "a*b", author_id: 10 }, returning: ["id"] });
    await driver.insert({ table: "posts", values: { id: 7, title: "a?b", author_id: 10 }, returning: ["id"] });
    const star = await driver.selectMany({
      table: "posts", columns: ["title"],
      where: { kind: "like", column: "title", pattern: "a*b" },
    });
    expect(star.map((r) => r.title)).toEqual(["a*b"]);
    const q = await driver.selectMany({
      table: "posts", columns: ["title"],
      where: { kind: "like", column: "title", pattern: "a?b" },
    });
    expect(q.map((r) => r.title)).toEqual(["a?b"]);
  });

  test("isNull", async () => {
    await driver.insert({ table: "posts", values: { id: 5, title: null, author_id: 10 }, returning: ["id"] });
    const rows = await driver.selectMany({
      table: "posts", columns: ["id"],
      where: { kind: "isNull", column: "title", not: false },
    });
    expect(rows.map((r) => r.id)).toEqual([5]);
  });

  test("and(...) composition", async () => {
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
