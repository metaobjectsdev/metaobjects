import { test, expect } from "bun:test";
import type { Change } from "@metaobjectsdev/migrate-ts";
import { describeChange, blockedEntriesFor, blockedHintLines } from "../../src/lib/allow.js";

// A type change carries its column's default change, so the plan and the drift
// summary must report the default on it or the default change disappears from both.
test("a type change that carries a default change says so", () => {
  const c: Change = {
    kind: "change-column-type", table: "orders", column: "status",
    from: { kind: "text" }, to: { kind: "integer", bits: 32 },
    fromDefault: { kind: "literal", value: "PUBLISHED" }, toDefault: { kind: "literal", value: "5" },
    status: { state: "allowed" },
  };
  expect(describeChange(c)).toBe("orders.status (text → integer, default PUBLISHED → 5)");
});

test("an unchanged default is not mentioned", () => {
  const zero = { kind: "literal", value: "0" } as const;
  const c: Change = {
    kind: "change-column-type", table: "orders", column: "qty",
    from: { kind: "integer", bits: 32 }, to: { kind: "integer", bits: 64 },
    fromDefault: zero, toDefault: zero, status: { state: "allowed" },
  };
  expect(describeChange(c)).toBe("orders.qty (integer → integer)");
});

// A blocked CHECK drop used to fall through to a JSON dump of the whole change object.
test("a CHECK change reads as text, naming the constraint and its rule", () => {
  const drop: Change = {
    kind: "drop-check", table: "reviews", check: "reviews_rating_numeric_chk",
    restore: { name: "reviews_rating_numeric_chk", expression: `"rating" >= 1 AND "rating" <= 5` },
    status: { state: "blocked", blockedReason: "destructive" },
  };
  const add: Change = {
    kind: "add-check", table: "reviews",
    check: { name: "reviews_stars_numeric_chk", expression: `"stars" >= 1 AND "stars" <= 5` },
    status: { state: "allowed" },
  };
  expect(describeChange(drop)).toBe(`reviews check reviews_rating_numeric_chk ("rating" >= 1 AND "rating" <= 5)`);
  expect(describeChange(add)).toBe(`reviews check reviews_stars_numeric_chk ("stars" >= 1 AND "stars" <= 5)`);
  const hint = blockedHintLines(blockedEntriesFor([drop], [drop, add])[0]!).join("\n");
  expect(hint).not.toContain("{");
  expect(hint).toContain("--allow drop-check");
});

test("every change kind reads as text, never JSON", () => {
  const kinds: Change[] = [
    { kind: "rename-column", table: "t", from: "a", to: "b", status: { state: "allowed" } },
    { kind: "change-column-default", table: "t", column: "a", status: { state: "allowed" } },
    { kind: "change-column-nullable", table: "t", column: "a", from: true, to: false, status: { state: "allowed" } },
    { kind: "replace-view", view: { name: "v", columns: [] }, status: { state: "allowed" } },
  ];
  for (const c of kinds) expect(describeChange(c)).not.toMatch(/^\{/);
});
