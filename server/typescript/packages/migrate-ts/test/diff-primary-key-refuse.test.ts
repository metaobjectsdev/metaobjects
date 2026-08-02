import { describe, test, expect } from "bun:test";
import { diff } from "../src/diff/index.js";
import { PrimaryKeyChangeError } from "../src/errors.js";
import type { SchemaSnapshot, TableDescriptor, ColumnDescriptor } from "../src/types.js";

// #258 — migrate has no primary-key change kind, so a table whose live PRIMARY KEY
// differs from the metadata identity degrades silently into add-column + drop-column
// (the old PK column is dropped, the new one is never made PK), leaving the table
// with no PK and breaking every referencing FK at apply time. The migration-generation
// diff must DETECT the move and REFUSE loudly rather than emit un-appliable SQL.

function table(name: string, columns: ColumnDescriptor[], primaryKey: string[]): TableDescriptor {
  return { name, columns, indexes: [], foreignKeys: [], primaryKey, checks: [] };
}
const col = (name: string, sqlType: ColumnDescriptor["sqlType"], identity?: "increment" | "uuid"): ColumnDescriptor =>
  ({ name, sqlType, nullable: false, ...(identity ? { identity } : {}) });

const UUID = { kind: "uuid" } as const;
const BIGINT = { kind: "integer", bits: 64 } as const;

// live table has PRIMARY KEY (user_id bigint); metadata identity is id (uuid).
const liveUserIdPk = (): SchemaSnapshot => ({
  tables: [table("user_profiles", [col("user_id", BIGINT)], ["user_id"])],
  views: [],
});
const metadataIdPk = (): SchemaSnapshot => ({
  tables: [table("user_profiles", [col("id", UUID, "uuid")], ["id"])],
  views: [],
});

describe("diff — #258 primary-key move detect-and-refuse", () => {
  test("REFUSES when the live PK differs from the metadata identity (add/drop, not a rename)", async () => {
    await expect(
      diff({ expected: metadataIdPk(), actual: liveUserIdPk(), refusePrimaryKeyChange: true }),
    ).rejects.toBeInstanceOf(PrimaryKeyChangeError);
  });

  test("the refusal names the table and both primary keys", async () => {
    try {
      await diff({ expected: metadataIdPk(), actual: liveUserIdPk(), refusePrimaryKeyChange: true });
      throw new Error("expected diff to refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(PrimaryKeyChangeError);
      const err = e as PrimaryKeyChangeError;
      expect(err.table).toBe("user_profiles");
      expect(err.livePrimaryKey).toEqual(["user_id"]);
      expect(err.expectedPrimaryKey).toEqual(["id"]);
      expect(err.message).toContain("user_profiles");
    }
  });

  test("does NOT refuse when the primary key is unchanged", async () => {
    const same = (): SchemaSnapshot => ({
      tables: [table("user_profiles", [col("id", UUID, "uuid")], ["id"])],
      views: [],
    });
    const r = await diff({ expected: same(), actual: same(), refusePrimaryKeyChange: true });
    expect(r.changes).toEqual([]);
  });

  test("does NOT refuse a PK-column RENAME (rename resolved → PK preserved by the engine)", async () => {
    const actual: SchemaSnapshot = { tables: [table("t", [col("user_id", BIGINT)], ["user_id"])], views: [] };
    const expected: SchemaSnapshot = { tables: [table("t", [col("userId", BIGINT)], ["userId"])], views: [] };
    const r = await diff({
      expected,
      actual,
      refusePrimaryKeyChange: true,
      allow: { dropColumn: true },
      onAmbiguous: async () => "rename",
    });
    // The renamed PK column is a rename-column change; the PK is preserved, so no refusal.
    expect(r.changes.some((c) => c.kind === "rename-column")).toBe(true);
  });

  test("without the flag, diff does not throw — the verify/drift path is unchanged", async () => {
    const r = await diff({ expected: metadataIdPk(), actual: liveUserIdPk(), allow: { dropColumn: true } });
    expect(r).toBeDefined();
    // The un-fixed behavior: silent add-column + drop-column, PK move lost.
    expect(r.changes.some((c) => c.kind === "add-column")).toBe(true);
    expect(r.changes.some((c) => c.kind === "drop-column")).toBe(true);
  });
});
