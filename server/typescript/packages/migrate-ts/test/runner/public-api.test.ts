// test/runner/public-api.test.ts
import { test, expect } from "bun:test";
import * as mt from "../../src/index.js";

test("runner is exported from the package entry", () => {
  expect(typeof mt.applyMigrations).toBe("function");
  expect(typeof mt.rollbackTo).toBe("function");
  expect(typeof mt.PgHistoryStore).toBe("function");
  expect(typeof mt.PgExecutor).toBe("function");
  expect(typeof mt.loadMigrations).toBe("function");
});
