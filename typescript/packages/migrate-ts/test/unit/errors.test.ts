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
