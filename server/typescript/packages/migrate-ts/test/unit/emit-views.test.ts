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
  const proven: Change[] = [{ ...replaceV[0]!, kind: "replace-view", proven: { restorable: true } } as Change];
  expect(emit(proven, { dialect: "postgres" }).up).toMatch(/CREATE OR REPLACE VIEW "v" AS/);
});

// Postgres refuses a replace that changes an existing column, and it refuses at apply. A
// replace nothing proved (a diff with no dialect, whose changes can be emitted for any
// database) is written the way SQLite writes every replace.
test("postgres writes an unproven replace as DROP + CREATE", () => {
  const { up, down } = emit(
    [{ kind: "replace-view", view: { name: "v", sql: "SELECT 1 AS x" }, restore: { name: "v", sql: "SELECT 0 AS x" }, status: ALLOWED }],
    { dialect: "postgres" },
  );
  expect(up).not.toMatch(/OR REPLACE/i);
  expect(up.indexOf('DROP VIEW IF EXISTS "v";')).toBeGreaterThanOrEqual(0);
  expect(up.indexOf('DROP VIEW IF EXISTS "v";')).toBeLessThan(up.indexOf('CREATE VIEW "v" AS'));
  expect(down).not.toMatch(/OR REPLACE/i);
  expect(down.indexOf('DROP VIEW "v";')).toBeLessThan(down.indexOf('CREATE VIEW "v" AS\nSELECT 0 AS x;'));
});

test("postgres restores a proven replace in place only when the columns are the same", () => {
  const replace = (restorable: boolean): Change[] => [{
    kind: "replace-view", view: { name: "v", sql: "SELECT 1 AS x" }, restore: { name: "v", sql: "SELECT 0 AS x" },
    proven: { restorable }, status: ALLOWED,
  }];
  const inPlace = emit(replace(true), { dialect: "postgres" }).down;
  expect(inPlace).toContain('CREATE OR REPLACE VIEW "v" AS\nSELECT 0 AS x;');
  expect(inPlace).not.toContain("DROP VIEW");
  // An appended column: undoing it removes one, which a replace cannot do.
  const dropped = emit(replace(false), { dialect: "postgres" }).down;
  expect(dropped).not.toMatch(/OR REPLACE/i);
  expect(dropped.indexOf('DROP VIEW "v";')).toBeLessThan(dropped.indexOf('CREATE VIEW "v" AS\nSELECT 0 AS x;'));
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
