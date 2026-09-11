import { test, expect } from "bun:test";
import { BlockedChangesError } from "../../src/errors.js";
import type { Change } from "../../src/types.js";

test("BlockedChangesError exposes blocked changes and enable hints", () => {
  const blocked: Change[] = [
    {
      kind: "drop-column",
      table: "users",
      column: "email",
      status: { state: "blocked", blockedReason: "destructive: drop-column not allowed" },
    },
    {
      kind: "drop-table",
      table: "legacy_log",
      status: { state: "blocked", blockedReason: "destructive: drop-table not allowed" },
    },
  ];

  const err = new BlockedChangesError(blocked);

  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("BlockedChangesError");
  expect(err.blocked).toBe(blocked);
  expect(err.enableHints).toEqual([
    "drop-column on users.email: pass allow.dropColumn",
    "drop-table on legacy_log: pass allow.dropTable",
  ]);
  expect(err.message).toContain("2 blocked change(s)");
  expect(err.message).toContain("drop-column on users.email");
  expect(err.message).toContain("allow.dropColumn");
});

test("BlockedChangesError handles change-column-type", () => {
  const blocked: Change[] = [
    {
      kind: "change-column-type",
      table: "orders",
      column: "amount",
      from: { kind: "numeric", precision: 10, scale: 2 },
      to: { kind: "integer", bits: 32 },
      status: { state: "blocked", blockedReason: "lossy type change" },
    },
  ];
  const err = new BlockedChangesError(blocked);
  expect(err.enableHints).toEqual([
    "change-column-type on orders.amount: pass allow.typeChange",
  ]);
});

// The flag is chosen by what BLOCKED the change. A type change carries its column's
// default change, so one that would drop a live auto-sequence default is blocked by
// that, and allow.typeChange would leave the user looping on the hint.
test("BlockedChangesError names allow.dropIdentityDefault for a type change blocked by its folded default", () => {
  const blocked: Change[] = [{
    kind: "change-column-type", table: "users", column: "id",
    from: { kind: "integer", bits: 32 }, to: { kind: "integer", bits: 64 },
    fromDefault: { kind: "expr", value: "nextval('users_id_seq'::regclass)" },
    status: { state: "blocked", blockedReason: "auto-increment default" },
  }];
  expect(new BlockedChangesError(blocked).enableHints)
    .toEqual(["change-column-type on users.id: pass allow.dropIdentityDefault"]);
});

test("BlockedChangesError names allow.dropCheck for a blocked drop-check", () => {
  const blocked: Change[] = [{
    kind: "drop-check", table: "orders", check: "orders_status_chk",
    status: { state: "blocked", blockedReason: "destructive: drop-check not allowed (pass allow.dropCheck)" },
  }];
  expect(new BlockedChangesError(blocked).enableHints)
    .toEqual(["drop-check on orders.orders_status_chk: pass allow.dropCheck"]);
});
