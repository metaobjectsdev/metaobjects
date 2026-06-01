import { describe, test, expect } from "bun:test";
import type { Change } from "../../src/types.js";
import { emit } from "../../src/emit/index.js";
import { applyStatus } from "../../src/diff/status.js";

const CHK = { name: "orders_qty_numeric_chk", expression: "qty >= 1" };

describe("drop-check: restore down + allow gating", () => {
  test("drop-check with restore → down re-adds the constraint", () => {
    const c = { kind: "drop-check", table: "orders", check: CHK.name, restore: CHK, status: { state: "allowed" } } as unknown as Change;
    const r = emit([c], { dialect: "postgres" });
    expect(r.up).toContain(`ALTER TABLE "orders" DROP CONSTRAINT "orders_qty_numeric_chk";`);
    expect(r.down).toContain(`ALTER TABLE "orders" ADD CONSTRAINT "orders_qty_numeric_chk" CHECK (qty >= 1);`);
  });
  test("drop-check is blocked unless allow.dropCheck", () => {
    const blocked = [{ kind: "drop-check", table: "orders", check: CHK.name, status: { state: "allowed" } } as unknown as Change];
    applyStatus(blocked, {});
    expect(blocked[0]!.status.state).toBe("blocked");
    const allowed = [{ kind: "drop-check", table: "orders", check: CHK.name, status: { state: "allowed" } } as unknown as Change];
    applyStatus(allowed, { dropCheck: true });
    expect(allowed[0]!.status.state).toBe("allowed");
  });
  test("add-check stays always-allowed", () => {
    const c = [{ kind: "add-check", table: "orders", check: CHK, status: { state: "allowed" } } as unknown as Change];
    applyStatus(c, {});
    expect(c[0]!.status.state).toBe("allowed");
  });
});
