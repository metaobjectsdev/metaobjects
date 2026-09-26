// View DDL is rendered by every dialect — there is no postgres-only gate.
// Postgres uses CREATE [OR REPLACE] VIEW with schema namespacing; sqlite/d1 have
// no CREATE OR REPLACE and no schemas, so a replace is DROP+CREATE.

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
  expect(emit(createV, { dialect: "postgres" }).up).toMatch(/CREATE VIEW/i);
  expect(emit(dropV, { dialect: "postgres" }).up).toMatch(/DROP VIEW/i);
  expect(emit(replaceV, { dialect: "postgres" }).up).toMatch(/CREATE OR REPLACE VIEW/i);
});

test("sqlite renders view DDL (DROP+CREATE for replace, no OR REPLACE)", () => {
  const create = emit(createV, { dialect: "sqlite" }).up;
  expect(create).toContain(`CREATE VIEW "v" AS`);
  expect(create).not.toMatch(/OR REPLACE/i);

  expect(emit(dropV, { dialect: "sqlite" }).up).toContain(`DROP VIEW IF EXISTS "v"`);

  const replace = emit(replaceV, { dialect: "sqlite" }).up;
  expect(replace).toContain(`DROP VIEW IF EXISTS "v"`);
  expect(replace).toContain(`CREATE VIEW "v" AS`);
});

test("sqlite down RESTORES a dropped/replaced view from the introspected definition", () => {
  const live = { name: "v", sql: `CREATE VIEW "v" AS SELECT 0 AS x` };
  const drop: Change[] = [{ kind: "drop-view", view: "v", restore: live, status: ALLOWED }];
  expect(emit(drop, { dialect: "sqlite" }).down).toBe(`CREATE VIEW "v" AS SELECT 0 AS x;`);

  const replace: Change[] = [
    { kind: "replace-view", view: { name: "v", sql: "SELECT 1 AS x" }, restore: live, status: ALLOWED },
  ];
  expect(emit(replace, { dialect: "sqlite" }).down).toBe(`DROP VIEW IF EXISTS "v";\nCREATE VIEW "v" AS SELECT 0 AS x;`);

  // A bare body (the expected side's form) is wrapped.
  const bare: Change[] = [{ kind: "drop-view", view: "v", restore: { name: "v", sql: "SELECT 2 AS x" }, status: ALLOWED }];
  expect(emit(bare, { dialect: "sqlite" }).down).toBe(`CREATE VIEW "v" AS\nSELECT 2 AS x;`);
});

test("d1 renders view DDL the same way as sqlite", () => {
  const create = emit(createV, { dialect: "d1" }).up;
  expect(create).toContain(`CREATE VIEW "v" AS`);
  const replace = emit(replaceV, { dialect: "d1" }).up;
  expect(replace).toContain(`DROP VIEW IF EXISTS "v"`);
  expect(replace).toContain(`CREATE VIEW "v" AS`);
});
