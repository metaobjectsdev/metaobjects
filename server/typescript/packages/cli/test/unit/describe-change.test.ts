import { test, expect } from "bun:test";
import type { Change } from "@metaobjectsdev/migrate-ts";
import { describeChange } from "../../src/lib/allow.js";

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
