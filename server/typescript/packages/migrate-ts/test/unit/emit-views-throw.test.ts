// Views are postgres-only in migrate-ts today. Sqlite + d1 emit() must reject
// any view-kind change with a clear error so consumers learn the limit at
// migration time, not in the resulting DDL.

import { test, expect } from "bun:test";
import { emit } from "../../src/emit/index.js";
import type { Change } from "../../src/types.js";

const ALLOWED = { state: "allowed" as const };
const createV: Change[] = [
  { kind: "create-view", view: { name: "v", sql: "SELECT 1 AS x" }, status: ALLOWED },
];
const dropV: Change[] = [{ kind: "drop-view", view: "v", status: ALLOWED }];
const replaceV: Change[] = [
  { kind: "replace-view", view: { name: "v", sql: "SELECT 1 AS x" }, status: ALLOWED },
];

test("postgres emits all three view kinds", () => {
  expect(() => emit(createV, { dialect: "postgres" })).not.toThrow();
  expect(() => emit(dropV, { dialect: "postgres" })).not.toThrow();
  expect(() => emit(replaceV, { dialect: "postgres" })).not.toThrow();
});

test("sqlite refuses all three view kinds with a clear error", () => {
  for (const c of [createV, dropV, replaceV]) {
    expect(() => emit(c, { dialect: "sqlite" })).toThrow(/view migration not implemented for dialect/);
  }
});

test("d1 refuses all three view kinds with a clear error", () => {
  for (const c of [createV, dropV, replaceV]) {
    expect(() => emit(c, { dialect: "d1" })).toThrow(/view migration not implemented for dialect/);
  }
});
