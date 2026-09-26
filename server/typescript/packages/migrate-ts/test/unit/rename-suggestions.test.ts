import { test, expect, describe } from "bun:test";
import { suggestColumnRenames } from "../../src/diff/rename-suggestions.js";
import { BlockedChangesError } from "../../src/errors.js";
import { emit } from "../../src/emit/index.js";
import type { Change, ColumnDescriptor } from "../../src/types.js";

// A column the model renamed (title → summary) that the rename heuristic did not pair
// (the names are too far apart) reaches the author as a blocked drop plus an add in the
// same table. `--allow drop-column` "fixes" that by deleting the column's data; the
// declared rename keeps it. Every hint on that shape must say so, rename FIRST.

const text: ColumnDescriptor["sqlType"] = { kind: "text" };
const col = (name: string, over: Partial<ColumnDescriptor> = {}): ColumnDescriptor =>
  ({ name, sqlType: text, nullable: false, ...over });
const drop = (table: string, column: string, restore?: ColumnDescriptor, schema?: string): Change => ({
  kind: "drop-column", table, column,
  ...(schema !== undefined ? { schema } : {}),
  ...(restore !== undefined ? { restore } : {}),
  status: { state: "blocked", blockedReason: "destructive: drop-column not allowed" },
});
const add = (table: string, column: ColumnDescriptor, schema?: string): Change => ({
  kind: "add-column", table, column,
  ...(schema !== undefined ? { schema } : {}),
  status: { state: "allowed" },
});

describe("suggestColumnRenames", () => {
  test("pairs a drop with an add in the same table", () => {
    expect(suggestColumnRenames([drop("issues", "title", col("title")), add("issues", col("summary"))]))
      .toEqual([{ table: "issues", from: "title", to: "summary" }]);
  });

  test("does not pair across tables or schemas", () => {
    expect(suggestColumnRenames([drop("issues", "title", col("title")), add("comments", col("summary"))])).toEqual([]);
    expect(suggestColumnRenames([
      drop("issues", "title", col("title"), "a"), add("issues", col("summary"), "b"),
    ])).toEqual([]);
  });

  test("prefers the add whose shape matches, and carries the schema", () => {
    const got = suggestColumnRenames([
      drop("issues", "title", col("title"), "app"),
      add("issues", col("count", { sqlType: { kind: "integer", bits: 32 } }), "app"),
      add("issues", col("summary"), "app"),
    ]);
    expect(got).toEqual([{ table: "issues", schema: "app", from: "title", to: "summary" }]);
  });

  test("names the shape change when the only candidate differs in shape", () => {
    const got = suggestColumnRenames([drop("issues", "title", col("title")), add("issues", col("summary", { nullable: true }))]);
    expect(got).toHaveLength(1);
    expect(got[0]!.shapeChange).toContain("nullability");
  });

  test("never pairs one add with two drops", () => {
    const got = suggestColumnRenames([
      drop("issues", "title", col("title")), drop("issues", "body", col("body")), add("issues", col("summary")),
    ]);
    expect(got).toEqual([{ table: "issues", from: "title", to: "summary" }]);
  });
});

describe("BlockedChangesError on a pairable drop+add", () => {
  test("recommends the declared rename first and calls allow.dropColumn data-losing", () => {
    const changes = [drop("issues", "title", col("title")), add("issues", col("summary"))];
    const err = new BlockedChangesError(changes.filter((c) => c.status.state === "blocked"), changes);
    const hint = err.enableHints[0]!;
    expect(hint).toContain(`{ kind: "column", table: "issues", from: "title", to: "summary" }`);
    expect(hint.indexOf("renames")).toBeLessThan(hint.indexOf("allow.dropColumn"));
    expect(hint).toMatch(/allow\.dropColumn.*(delete|DELETE)/);
  });

  test("emit() passes the full change list so the hint can pair", () => {
    const changes = [drop("issues", "title", col("title")), add("issues", col("summary"))];
    try {
      emit(changes, { dialect: "postgres" });
      throw new Error("expected emit to throw");
    } catch (e) {
      expect((e as BlockedChangesError).enableHints[0]).toContain("renames");
    }
  });

  test("an unpaired drop keeps the plain allow hint", () => {
    const blocked = [drop("users", "email")];
    expect(new BlockedChangesError(blocked, blocked).enableHints)
      .toEqual(["drop-column on users.email: pass allow.dropColumn"]);
  });
});
