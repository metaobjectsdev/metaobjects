import { test, expect } from "bun:test";
import { emit } from "../../src/emit/index.js";
import { BlockedChangesError } from "../../src/errors.js";
import type { Change } from "../../src/types.js";

test("emit throws BlockedChangesError when any change is blocked", () => {
  const changes: Change[] = [
    { kind: "drop-column", table: "users", column: "legacy", status: { state: "blocked", blockedReason: "destructive" } },
  ];
  expect(() => emit(changes, { dialect: "postgres" })).toThrow(BlockedChangesError);
});

test("emit error message lists every blocked change", () => {
  const changes: Change[] = [
    { kind: "drop-column", table: "u", column: "a", status: { state: "blocked", blockedReason: "x" } },
    { kind: "drop-table", table: "old", status: { state: "blocked", blockedReason: "y" } },
  ];
  try {
    emit(changes, { dialect: "postgres" });
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(BlockedChangesError);
    expect((e as BlockedChangesError).blocked).toHaveLength(2);
  }
});
