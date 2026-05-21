import { test, expect } from "bun:test";
import { emit } from "../../src/emit/index.js";
import type { Change } from "../../src/types.js";

test("create-view causes emit to throw 'view migration not implemented'", () => {
  const changes: Change[] = [
    { kind: "create-view", view: { name: "v" }, status: { state: "allowed" } },
  ];
  expect(() => emit(changes, { dialect: "postgres" })).toThrow(/view migration not implemented/);
});

test("drop-view + replace-view also throw", () => {
  const dropV: Change[] = [{ kind: "drop-view", view: "v", status: { state: "allowed" } }];
  const repV: Change[] = [{ kind: "replace-view", view: { name: "v" }, status: { state: "allowed" } }];
  expect(() => emit(dropV, { dialect: "sqlite" })).toThrow(/view migration not implemented/);
  expect(() => emit(repV, { dialect: "postgres" })).toThrow(/view migration not implemented/);
});
