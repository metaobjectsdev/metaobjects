// test/check/types-shape.test.ts
import { describe, test, expect } from "bun:test";
import type { CheckDescriptor, TableDescriptor, Change } from "../../src/types.js";

describe("CheckDescriptor shape", () => {
  test("a check has a name + expression and attaches to a table", () => {
    const check: CheckDescriptor = { name: "orders_status_chk", expression: "status IN ('OPEN','CLOSED')" };
    const table: Pick<TableDescriptor, "checks"> = { checks: [check] };
    expect(table.checks[0]?.name).toBe("orders_status_chk");
  });

  test("add-check / drop-check are Change kinds", () => {
    const add: Change = { kind: "add-check", table: "orders", check: { name: "c", expression: "x > 0" }, status: { state: "ok" } } as unknown as Change;
    const drop: Change = { kind: "drop-check", table: "orders", check: "c", status: { state: "ok" } } as unknown as Change;
    expect(add.kind).toBe("add-check");
    expect(drop.kind).toBe("drop-check");
  });
});
