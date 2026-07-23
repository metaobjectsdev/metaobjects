# Int-Backed Enum Values — TypeScript Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `field.enum`'s `@intValueMap` (metamodel layer already shipped in `docs/superpowers/plans/2026-07-23-int-backed-enum-values-metamodel.md`) into TypeScript's persistence stack: migrate-ts emits `integer` + a numeric `CHECK` instead of `text` + a string `CHECK`, codegen-ts's Drizzle column mapper follows suit, and the generated entity/query code translates symbol↔int at the DB boundary while every TS-facing type (Zod schema, `EntityType`, wire JSON) stays exactly the string union it is today.

**Architecture:** `@intValueMap`'s presence is read in exactly three places, each already dispatching on `field.subType === FIELD_SUBTYPE_ENUM`: migrate-ts's `subtypeToSqlType`/`arrayElementSqlType`/`buildChecks` (schema/DDL), codegen-ts's `column-mapper.ts` (Drizzle column declaration), and a **new** generated symbol↔int lookup consumed by two new template hooks — a Zod `.transform()` on write (an established pattern already used for `@autoSet` timestamps) and a small generated `decode` step on read (a genuinely new pattern for this codebase — no field has ever needed a wire type that differs from its storage type before). The migration-safety guard from the design's D8 needs **no new code at all**: this codebase's existing `isWidening`/`allow.typeChange` mechanism (`packages/migrate-ts/src/sql-type.ts` + `packages/migrate-ts/src/diff/status.ts`) already treats any cross-`kind` `change-column-type` (text↔integer included) as blocked-by-default requiring an explicit `allow.typeChange` pass — confirmed by reading `isWidening`'s `if (from.kind !== to.kind) return false` and `blockedReasonFor`'s `case "change-column-type"` branch. This task's job here is a **test proving that's true**, not new gating logic.

**Tech Stack:** TypeScript, Bun test runner, Drizzle ORM, Kysely (via `@metaobjectsdev/runtime-ts`), Zod.

## Global Constraints

- Every TS-facing type (Zod schema output type, generated `EntityType`, the JSON wire payload) is BYTE-IDENTICAL between string-backed and int-backed enums — string in, string out, everywhere except the literal DB column.
- `@intValueMap` presence alone is the trigger — no new codegen option, no new CLI flag.
- Do not touch the metamodel/validation layer — that plan already shipped. If a step here tempts you to edit `attr-schema-validate.ts` or add a new attr constant, stop; it's already done.
- The migration-safety guard requires ZERO new gating code (see Architecture) — this plan's migration-safety task is a test, not an implementation.

---

### Task 1: migrate-ts — `integer` column type for int-backed enums

**Files:**
- Modify: `packages/migrate-ts/src/expected-schema.ts`
- Test: `packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts`

**Interfaces:**
- Consumes: `FIELD_ATTR_INT_VALUE_MAP` (metamodel plan, already shipped).
- Produces: `buildExpectedSchema(...)` returns `{ kind: "integer", bits: 32 }` for a scalar int-backed enum column, `{ kind: "array", element: { kind: "integer", bits: 32 } }` for an array one — consumed by Task 2 (CHECK) and by `diff/index.ts`'s existing (unmodified) column-type comparison.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts
import { describe, test, expect } from "bun:test";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { loadFixture } from "../fixtures/load.js"; // match the existing helper used by expected-schema.test.ts

describe("buildExpectedSchema — int-backed field.enum (@intValueMap)", () => {
  test("scalar int-backed enum maps to integer, not text", async () => {
    const root = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}`);
    const snapshot = buildExpectedSchema(root);
    const col = snapshot.tables[0]!.columns.find((c) => c.name === "status")!;
    expect(col.sqlType).toEqual({ kind: "integer", bits: 32 });
  });

  test("string-backed enum (no @intValueMap) is unchanged", async () => {
    const root = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}`);
    const snapshot = buildExpectedSchema(root);
    const col = snapshot.tables[0]!.columns.find((c) => c.name === "status")!;
    expect(col.sqlType).toEqual({ kind: "text" });
  });

  test("array-of-int-backed-enum maps to integer[]", async () => {
    const root = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Ticket", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "labels", "isArray": true, "@values": ["LOW","MEDIUM","HIGH"], "@intValueMap": { "LOW": 1, "MEDIUM": 2, "HIGH": 3 } } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}`);
    const snapshot = buildExpectedSchema(root);
    const col = snapshot.tables[0]!.columns.find((c) => c.name === "labels")!;
    expect(col.sqlType).toEqual({ kind: "array", element: { kind: "integer", bits: 32 } });
  });
});
```

> Check `packages/migrate-ts/test/unit/expected-schema.test.ts`'s actual fixture-loading helper (`loadFixture`, or whatever it's really called) before finalizing — mirror its exact signature.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/typescript && bun test packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts`
Expected: FAIL — the first and third tests currently get `{ kind: "text" }`/`{ kind: "array", element: { kind: "text" } }`.

- [ ] **Step 3: Add the scalar case to `subtypeToSqlType`**

Edit `packages/migrate-ts/src/expected-schema.ts` — in `subtypeToSqlType` (the switch shown in research, ending at the `default: return { kind: "text" }` around line 1045), add a case immediately before `default`:

```typescript
    case FIELD_SUBTYPE_ENUM:
      // @intValueMap present → this enum is int-backed (docs/superpowers/specs/
      // 2026-07-23-int-backed-enum-values-design.md D5/D6). ADR-0039: resolving —
      // @intValueMap may be inherited via extends, same as @values.
      return field.attr(FIELD_ATTR_INT_VALUE_MAP) !== undefined
        ? { kind: "integer", bits: 32 }
        : { kind: "text" };
```

Add `FIELD_SUBTYPE_ENUM` and `FIELD_ATTR_INT_VALUE_MAP` to this file's existing `@metaobjectsdev/metadata` import block (both already exist as exports — `FIELD_SUBTYPE_ENUM` is likely already imported for other uses in this file; check before adding a duplicate).

- [ ] **Step 4: Add the array-element case to `arrayElementSqlType`**

Edit the same file's `arrayElementSqlType` function (research found the enum branch around line 949, grouped with `FIELD_SUBTYPE_URI`):

```typescript
    case FIELD_SUBTYPE_ENUM:
      // enum[] stores as text[] (string-backed) or integer[] (int-backed, when
      // @intValueMap is present); membership is app-level either way (no CHECK
      // on array columns — see buildChecks).
      return field.attr(FIELD_ATTR_INT_VALUE_MAP) !== undefined
        ? { kind: "integer", bits: 32 }
        : { kind: "text" };
    case FIELD_SUBTYPE_URI:
      return { kind: "text" };
```

(Remove the old combined `case FIELD_SUBTYPE_ENUM: case FIELD_SUBTYPE_URI: return { kind: "text" };` line and replace with the two separate cases above.)

- [ ] **Step 5: Run tests — confirm all pass**

Run: `cd server/typescript && bun test packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 6: Run the full migrate-ts suite**

Run: `cd server/typescript && bun test packages/migrate-ts`
Expected: all pass, no regressions (this step only adds a new case; every existing string-backed-enum test is untouched).

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/expected-schema.ts server/typescript/packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts
git commit -m "feat(migrate-ts): int-backed field.enum (@intValueMap) maps to integer, not text"
```

---

### Task 2: migrate-ts — numeric `CHECK` constraint for int-backed enums

**Files:**
- Modify: `packages/migrate-ts/src/expected-schema.ts`
- Test: extend `packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts`

**Interfaces:**
- Consumes: Task 1.

- [ ] **Step 1: Write the failing test**

Append to `expected-schema-enum-intvaluemap.test.ts`:

```typescript
test("int-backed enum gets a numeric CHECK (unquoted literals)", async () => {
  const root = await loadFixture(`{ "metadata.root": { "children": [
    { "object.entity": { "name": "Order", "children": [
      { "field.long": { "name": "id" } },
      { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
      { "identity.primary": { "name": "pk", "@fields": ["id"] } }
    ]}}
  ]}}`);
  const snapshot = buildExpectedSchema(root);
  const check = snapshot.tables[0]!.checks.find((c) => c.name === "orders_status_chk")!;
  expect(check.expression).toBe('"status" IN (0, 5, 9)');
});

test("int-backed array-of-enum gets NO check (array columns never get a CHECK)", async () => {
  const root = await loadFixture(`{ "metadata.root": { "children": [
    { "object.entity": { "name": "Ticket", "children": [
      { "field.long": { "name": "id" } },
      { "field.enum": { "name": "labels", "isArray": true, "@values": ["LOW","MEDIUM"], "@intValueMap": { "LOW": 1, "MEDIUM": 2 } } },
      { "identity.primary": { "name": "pk", "@fields": ["id"] } }
    ]}}
  ]}}`);
  const snapshot = buildExpectedSchema(root);
  expect(snapshot.tables[0]!.checks.find((c) => c.name === "tickets_labels_chk")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server/typescript && bun test packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts`
Expected: FAIL — the CHECK expression is currently the quoted-string form (`"status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')`), since `buildChecks` doesn't yet know about `@intValueMap`.

- [ ] **Step 3: Update `buildChecks`'s enum branch**

Edit `packages/migrate-ts/src/expected-schema.ts`'s `buildChecks` function (the block shown in research at lines 653-664):

```typescript
    // Enum membership check.
    if (field.subType === FIELD_SUBTYPE_ENUM) {
      const intValueMap = field.attr(FIELD_ATTR_INT_VALUE_MAP);
      if (intValueMap !== undefined && typeof intValueMap === "object" && intValueMap !== null) {
        // Int-backed: unquoted numeric literals, in the SAME member order as @values
        // (cosmetic only — SQL IN() is order-independent, but matching declaration
        // order keeps the emitted CHECK stable/predictable for diffing).
        const raw = field.attr(FIELD_ATTR_VALUES);
        const members: string[] = Array.isArray(raw) ? raw.map((v) => String(v)) : [];
        const ints = members.map((m) => (intValueMap as Record<string, number>)[m]);
        const expression = `${qcol} IN (${ints.join(", ")})`;
        checks.push({ name: `${tableName}_${col}_chk`, expression });
      } else {
        const raw = field.attr(FIELD_ATTR_VALUES);
        if (Array.isArray(raw) && raw.length > 0) {
          const values = raw.map((v) => String(v));
          const expression = `${qcol} IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`;
          checks.push({ name: `${tableName}_${col}_chk`, expression });
        }
      }
    }
```

- [ ] **Step 4: Run tests — confirm all pass**

Run: `cd server/typescript && bun test packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts`
Expected: PASS — all 5 tests in this file green.

- [ ] **Step 5: Run the full migrate-ts suite**

Run: `cd server/typescript && bun test packages/migrate-ts`
Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/expected-schema.ts server/typescript/packages/migrate-ts/test/unit/expected-schema-enum-intvaluemap.test.ts
git commit -m "feat(migrate-ts): int-backed field.enum CHECK uses unquoted numeric literals"
```

---

### Task 3: migrate-ts — prove the migration-safety guard (no new code)

**Files:**
- Test: `packages/migrate-ts/test/integration/sqlite-enum-backing-mode-change.test.ts`

**Interfaces:**
- Consumes: Task 1 (column type), the existing `isWidening`/`applyStatus` mechanism (unmodified).

- [ ] **Step 1: Write the real-engine test**

```typescript
// packages/migrate-ts/test/integration/sqlite-enum-backing-mode-change.test.ts
import { describe, test, expect } from "bun:test";
import Database from "better-sqlite3"; // match whatever driver this test dir's other integration tests already use
import { diff } from "../../src/diff/index.js";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspect } from "../../src/introspect/sqlite.js"; // match the actual introspect module path used by sibling tests
import { loadFixture } from "../fixtures/load.js";
import { apply } from "../../src/act/sqlite.js"; // match the actual apply/act module path

describe("SQLite enum backing-mode change — real-engine migration-safety guard", () => {
  test("adding @intValueMap to an EXISTING string-backed enum column is BLOCKED by default", async () => {
    const db = new Database(":memory:");
    const stringBackedRoot = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"] } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ]}}
    ]}}`);
    const initial = buildExpectedSchema(stringBackedRoot, { dialect: "sqlite" });
    // Apply the initial (string-backed) schema for real, so introspection sees a real
    // existing text column — this is what makes the guard fire (there is no diff at
    // all against an empty DB; the guard is specifically about an EXISTING column).
    const firstDiff = diff({ actual: { tables: [], views: [] }, expected: initial, dialect: "sqlite" });
    await apply(db, firstDiff.changes);

    const intBackedRoot = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5 } } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ]}}
    ]}}`);
    const expected = buildExpectedSchema(intBackedRoot, { dialect: "sqlite" });
    const actual = await introspect(db, "sqlite");
    const secondDiff = diff({ actual, expected, dialect: "sqlite" });

    const typeChange = secondDiff.changes.find((c) => c.kind === "change-column-type" && c.column === "status");
    expect(typeChange).toBeDefined();
    expect(typeChange!.status.state).toBe("blocked");
    expect(typeChange!.status.blockedReason).toContain("allow.typeChange");
    expect(secondDiff.blocked).toContain(typeChange);
  });

  test("passing allow.typeChange unblocks it (operator opt-in, per D8 — no silent auto-migration)", async () => {
    const db = new Database(":memory:");
    const stringBackedRoot = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"] } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ]}}
    ]}}`);
    const initial = buildExpectedSchema(stringBackedRoot, { dialect: "sqlite" });
    const firstDiff = diff({ actual: { tables: [], views: [] }, expected: initial, dialect: "sqlite" });
    await apply(db, firstDiff.changes);

    const intBackedRoot = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5 } } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ]}}
    ]}}`);
    const expected = buildExpectedSchema(intBackedRoot, { dialect: "sqlite" });
    const actual = await introspect(db, "sqlite");
    const secondDiff = diff({ actual, expected, dialect: "sqlite", allow: { typeChange: true } });

    const typeChange = secondDiff.changes.find((c) => c.kind === "change-column-type" && c.column === "status");
    expect(typeChange!.status.state).toBe("allowed");
  });
});
```

> This test's exact imports (`introspect`, `apply`, the SQLite driver) must match whatever `packages/migrate-ts/test/integration/sqlite-autoset-default.test.ts` (found during earlier investigation of this same package) actually uses — read that file first and mirror its setup/teardown and import paths exactly; the sketch above captures the SCENARIO, not necessarily the exact API surface.

- [ ] **Step 2: Run to verify current behavior**

Run: `cd server/typescript && bun test packages/migrate-ts/test/integration/sqlite-enum-backing-mode-change.test.ts`
Expected: Both tests should already PASS once Task 1 lands, since `isWidening`/`blockedReasonFor` need no changes — this step is confirming that expectation, not driving new implementation. If either test fails, the failure itself is the signal that D8's assumption (the existing generic mechanism already covers this) was wrong, and this task's scope needs to grow into an actual new guard (re-read `blockedReasonFor` in `packages/migrate-ts/src/diff/status.ts` and add a `change-column-type` sub-case specific to enum `text↔integer` transitions before proceeding).

- [ ] **Step 3: Run the full migrate-ts suite**

Run: `cd server/typescript && bun test packages/migrate-ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add server/typescript/packages/migrate-ts/test/integration/sqlite-enum-backing-mode-change.test.ts
git commit -m "test(migrate-ts): prove the existing allow.typeChange guard blocks enum backing-mode changes"
```

---

### Task 4: codegen-ts — Drizzle column mapper

**Files:**
- Modify: `packages/codegen-ts/src/column-mapper.ts`
- Test: `packages/codegen-ts/test/templates/column-mapper-enum-intvaluemap.test.ts`

**Interfaces:**
- Consumes: `enumValues(field)` from `packages/codegen-ts/src/enum-meta.ts` (existing) — this task adds a sibling `intValueMap(field)` reader to the same file.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/codegen-ts/test/templates/column-mapper-enum-intvaluemap.test.ts
import { describe, test, expect } from "bun:test";
import { mapColumnType } from "../../src/column-mapper.js";
import { loadFixture } from "../fixtures/load.js"; // match whatever helper column-mapper.test.ts already uses

describe("column-mapper — int-backed field.enum (@intValueMap)", () => {
  test("postgres: emits integer(...), not text(..., {enum:[...]})", async () => {
    const root = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5 } } }
      ]}}
    ]}}`);
    const field = root.findObject("Order")!.fields().find((f) => f.name === "status")!;
    const result = mapColumnType(field, "postgres");
    expect(result.fnName).toBe("integer");
    expect(result.fnOptions).toBeUndefined();
    expect(result.checkConstraint).toBe('"status" IN (0, 5)');
  });

  test("sqlite: emits integer(...), not text(..., {enum:[...]})", async () => {
    const root = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5 } } }
      ]}}
    ]}}`);
    const field = root.findObject("Order")!.fields().find((f) => f.name === "status")!;
    const result = mapColumnType(field, "sqlite");
    expect(result.fnName).toBe("integer");
  });

  test("string-backed enum (no @intValueMap) is unchanged on both dialects", async () => {
    const root = await loadFixture(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"] } }
      ]}}
    ]}}`);
    const field = root.findObject("Order")!.fields().find((f) => f.name === "status")!;
    expect(mapColumnType(field, "postgres").fnName).toBe("text");
    expect(mapColumnType(field, "sqlite").fnName).toBe("text");
  });
});
```

> `mapColumnType`'s exact exported name/signature and its result shape (`fnName`/`fnOptions`/`checkConstraint`) are inferred from the research report's excerpts — confirm against the actual function signature in `column-mapper.ts` (search for `export function mapColumnType` or similar) before finalizing.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/column-mapper-enum-intvaluemap.test.ts`
Expected: FAIL — currently `fnName` is `"text"` in every case.

- [ ] **Step 3: Add `intValueMap(field)` to `enum-meta.ts`**

Edit `packages/codegen-ts/src/enum-meta.ts` — add a sibling to `enumValues`:

```typescript
export function intValueMap(field: MetaField): Record<string, number> | undefined {
  const raw = field.attr(FIELD_ATTR_INT_VALUE_MAP);
  return typeof raw === "object" && raw !== null ? (raw as Record<string, number>) : undefined;
}
```

- [ ] **Step 4: Update `column-mapper.ts`'s dialect switches**

Edit both the SQLite switch (research: `:399`) and the Postgres switch (research: `:513-516`) to check `intValueMap(field)` before falling into the text case:

```typescript
    case FIELD_SUBTYPE_ENUM: {
      fnName = intValueMap(field) !== undefined ? "integer" : "text";
      break;
    }
```

(For Postgres, this REPLACES the current `default: fnName = "text"` grouping for enum — give enum its own case above `default` so it no longer falls into the shared default branch.)

- [ ] **Step 5: Guard the literal-union `{enum:[...]}` option and the CHECK-constraint emission**

Edit the existing blocks at research lines 527-532 and 663-674 — both are already gated on `fnName === "text"`/`subType === FIELD_SUBTYPE_ENUM && !isArray`, so once Step 4 makes `fnName` become `"integer"` for int-backed enums, the `{enum:[...]}` block already naturally skips (its `fnName === "text"` guard is now false). The CHECK-constraint block, however, unconditionally quotes string values — update it:

```typescript
if (subType === FIELD_SUBTYPE_ENUM && !isArray) {
  const map = intValueMap(field);
  if (map !== undefined) {
    const members = enumValues(field) ?? [];
    const ints = members.map((m) => map[m]);
    result.checkConstraint = `${dbName} IN (${ints.join(", ")})`;
  } else {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
      result.checkConstraint = `${dbName} IN (${list})`;
    }
  }
}
```

- [ ] **Step 6: Run tests — confirm all pass**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/column-mapper-enum-intvaluemap.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 7: Run the full codegen-ts suite**

Run: `cd server/typescript && bun test packages/codegen-ts`
Expected: all pass, no regressions in existing golden-file snapshots (no existing fixture uses `@intValueMap`, so no snapshot should change).

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/enum-meta.ts server/typescript/packages/codegen-ts/src/column-mapper.ts server/typescript/packages/codegen-ts/test/templates/column-mapper-enum-intvaluemap.test.ts
git commit -m "feat(codegen-ts): Drizzle column-mapper emits integer(...) for int-backed field.enum"
```

---

### Task 5: codegen-ts — symbol↔int codec at the write/read boundary

**Files:**
- Modify: `packages/codegen-ts/src/templates/zod-validators.ts`
- Modify: `packages/codegen-ts/src/templates/entity-file.ts`
- Modify: `packages/codegen-ts/src/templates/queries-file.ts`
- Test: `packages/codegen-ts/test/templates/enum-intvaluemap-codec.test.ts`

**Interfaces:**
- Consumes: `intValueMap(field)` (Task 4).
- Produces: for each int-backed enum field, a generated `<Field>_TO_INT`/`<Field>_FROM_INT` lookup pair (emitted in the entity file), a Zod `.transform()` on the Insert/Update schema (write), and a `decode<Entity>Row` helper applied at every read call site in `queries-file.ts` (read).

**Note — this is a genuinely new pattern for this codebase.** Research confirmed no existing field type needs a wire type that differs from its DB storage type; every existing "conversion" (SQLite boolean `mode`, Drizzle `numeric`→`string`) is the driver's own built-in behavior, not codegen-authored translation. Read every file this task touches in full before editing — the excerpts below are the exact, verified current content at the cited lines, but the surrounding template has more call sites than shown (e.g. TPH polymorphic reads) that may need the identical treatment; this task covers the vanilla (non-TPH) path completely and flags TPH as a follow-up if discovered incomplete.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/codegen-ts/test/templates/enum-intvaluemap-codec.test.ts
import { describe, test, expect } from "bun:test";
import { runGen } from "../../src/runner.js"; // match whatever golden-file tests already use to drive a full gen pass
import { loadFixtureProject } from "../fixtures/load-project.js"; // match the existing golden-test harness

describe("int-backed field.enum — generated codec", () => {
  test("entity file emits a symbol<->int lookup pair", async () => {
    const output = await runGen(await loadFixtureProject("enum-int-backed"));
    const entityFile = output.find((f) => f.path.endsWith("Order.ts"))!.contents;
    expect(entityFile).toContain('const ORDER_STATUS_TO_INT');
    expect(entityFile).toContain('const ORDER_STATUS_FROM_INT');
  });

  test("insert schema transforms the symbol to its int before Drizzle sees it", async () => {
    const output = await runGen(await loadFixtureProject("enum-int-backed"));
    const entityFile = output.find((f) => f.path.endsWith("Order.ts"))!.contents;
    expect(entityFile).toContain('.transform((v) => ORDER_STATUS_TO_INT[v])');
  });

  test("read paths decode the int back to its symbol", async () => {
    const output = await runGen(await loadFixtureProject("enum-int-backed"));
    const queriesFile = output.find((f) => f.path.endsWith("Order.queries.ts"))!.contents;
    expect(queriesFile).toContain("decodeOrderRow");
  });

  test("string-backed enum (no @intValueMap) generates no codec at all", async () => {
    const output = await runGen(await loadFixtureProject("enum-inline")); // the pre-existing string-backed fixture
    const entityFile = output.find((f) => f.path.endsWith(".ts") && !f.path.includes("queries"))!.contents;
    expect(entityFile).not.toContain("_TO_INT");
    expect(entityFile).not.toContain("_FROM_INT");
  });
});
```

> `runGen`/`loadFixtureProject` are placeholders for whatever harness `packages/codegen-ts/test/golden/*.test.ts` actually uses to drive a full generator pass against a fixture project — read one of those tests first and mirror its exact setup. You will also need a new fixture project under wherever `enum-inline`-equivalent codegen fixtures live for THIS package (distinct from the `fixtures/conformance/` ones — codegen-ts likely has its own `test/golden/` or `test/fixtures/` project layout) declaring an `Order` entity with an int-backed `status` field.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/enum-intvaluemap-codec.test.ts`
Expected: FAIL — none of this generated content exists yet.

- [ ] **Step 3: Emit the lookup pair in `entity-file.ts`**

Edit `packages/codegen-ts/src/templates/entity-file.ts` — for each field where `intValueMap(field) !== undefined`, emit (near the top of the file, alongside other per-entity constants):

```typescript
function intBackedEnumConstants(entity: MetaObject, ctx: GenContext): Code[] {
  const blocks: Code[] = [];
  for (const field of entity.fields()) {
    if (field.subType !== FIELD_SUBTYPE_ENUM) continue;
    const map = intValueMap(field);
    if (map === undefined) continue;
    const constName = `${screamingSnake(entity.name)}_${screamingSnake(field.name)}`;
    const toIntEntries = Object.entries(map).map(([k, v]) => `  ${JSON.stringify(k)}: ${v},`).join("\n");
    const fromIntEntries = Object.entries(map).map(([k, v]) => `  ${v}: ${JSON.stringify(k)},`).join("\n");
    blocks.push(code`
const ${constName}_TO_INT: Record<string, number> = {
${toIntEntries}
};
const ${constName}_FROM_INT: Record<number, string> = {
${fromIntEntries}
};
`);
  }
  return blocks;
}
```

Call `intBackedEnumConstants(entity, ctx)` from this file's main generator function and splice its output into the emitted file (alongside the existing Zod schema / type declarations — match how this file already assembles its output `Code[]` array).

> `screamingSnake` is a naming helper this codebase may already have (check `naming.ts` or similar in `packages/codegen-ts/src/`) — use the existing helper rather than writing a new one if one exists.

- [ ] **Step 4: Add the write-side `.transform()` in `zod-validators.ts`**

Edit `packages/codegen-ts/src/templates/zod-validators.ts` — in the same loop shown in research (lines 189-197, the `autoSet` check), add an `else if` branch before the final `else`:

```typescript
    const autoSet = child.attr(FIELD_ATTR_AUTO_SET);
    const map = child.subType === FIELD_SUBTYPE_ENUM ? intValueMap(child) : undefined;

    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) {
      insertFieldLines.push(
        code`  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
    } else if (map !== undefined) {
      const constName = `${screamingSnake(obj.name)}_${screamingSnake(child.name)}`;
      insertFieldLines.push(
        code`  ${child.name}: ${zodFieldExpr(child, obj, ctx)}.transform((v) => ${constName}_TO_INT[v])`,
      );
    } else {
      insertFieldLines.push(code`  ${child.name}: ${zodFieldExpr(child, obj, ctx)}`);
    }
```

Apply the identical `else if (map !== undefined)` branch to whichever sibling loop builds the Update schema's field lines (search this file for the second occurrence of a field-line-building loop — Insert and Update schemas are built by parallel loops in this file per the earlier research on `zod-validators.ts`).

- [ ] **Step 5: Add the read-side `decode<Entity>Row` helper and wire it into `queries-file.ts`**

Edit `packages/codegen-ts/src/templates/entity-file.ts` — emit one decode helper per entity that has ANY int-backed enum field:

```typescript
function decodeRowHelper(entity: MetaObject): Code | null {
  const intBackedFields = entity.fields().filter(
    (f) => f.subType === FIELD_SUBTYPE_ENUM && intValueMap(f) !== undefined,
  );
  if (intBackedFields.length === 0) return null;
  const assignments = intBackedFields.map((f) => {
    const constName = `${screamingSnake(entity.name)}_${screamingSnake(f.name)}`;
    return `    ${f.name}: ${constName}_FROM_INT[row.${f.name}],`;
  }).join("\n");
  return code`
export function decode${entity.name}Row<T extends { ${intBackedFields.map((f) => `${f.name}: number`).join("; ")} }>(row: T) {
  return {
    ...row,
${assignments}
  };
}
`;
}
```

Edit `packages/codegen-ts/src/templates/queries-file.ts` — wrap every read return with `decode${entityName}Row(...)` when the entity has at least one int-backed enum field (check once at the top of this file's generator function, e.g. `const hasIntBackedEnum = entity.fields().some((f) => f.subType === FIELD_SUBTYPE_ENUM && intValueMap(f) !== undefined)`), updating the `reads` block (research lines 165-175):

```typescript
export async function ${findByIdFnName(entityName)}(db: Db, ${pkField}: ${pkType}): Promise<${entityName} | null> {
  const [row] = await db.select().from(${viewVar}).where(${eqSym}(${viewVar}.${pkField}, ${pkField})).limit(1);
  return row ${hasIntBackedEnum ? `? decode${entityName}Row(row)` : "??"} : null;
}

export async function ${listFnName(entityName)}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${entityName}[]> {
  let q = db.select().from(${viewVar}).$dynamic();
  if (opts?.limit !== undefined) q = q.limit(opts.limit);
  if (opts?.offset !== undefined) q = q.offset(opts.offset);
  ${hasIntBackedEnum ? "return (await q).map(decode" + "${entityName}" + "Row);" : "return q;"}
}
```

> Write this as real template-string interpolation matching this file's actual `code\`...\`` tagged-template style — the snippet above is illustrative of the LOGIC (conditionally wrap with decode), not literal copy-paste, since the exact ternary-inside-template-literal syntax needs to match this codebase's `ts-poet`/`code` helper conventions. Also update `insertReturningView`'s second `db.select()` (research lines 232-251) with the same wrapping.

- [ ] **Step 6: Run tests — confirm all pass**

Run: `cd server/typescript && bun test packages/codegen-ts/test/templates/enum-intvaluemap-codec.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 7: Run the full codegen-ts suite**

Run: `cd server/typescript && bun test packages/codegen-ts`
Expected: all pass, no golden-snapshot regressions (no existing fixture has `@intValueMap`).

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/entity-file.ts server/typescript/packages/codegen-ts/src/templates/zod-validators.ts server/typescript/packages/codegen-ts/src/templates/queries-file.ts server/typescript/packages/codegen-ts/test/templates/enum-intvaluemap-codec.test.ts
git commit -m "feat(codegen-ts): symbol<->int codec for int-backed field.enum at the Drizzle boundary"
```

---

### Task 6: persistence-conformance — real round-trip

**Files:**
- Modify: `fixtures/persistence-conformance/canonical/meta.fitness.json`
- Modify: `fixtures/persistence-conformance/queries/roundtrip-all-types.yaml`
- Verify: TS's real-engine round-trip test run

**Interfaces:**
- Consumes: Tasks 1-5.

- [ ] **Step 1: Add an int-backed enum field to the `AllTypes` entity**

Edit `fixtures/persistence-conformance/canonical/meta.fitness.json` — add a sibling field next to the existing `enumVal` (found at line 243):

```json
{ "field.enum": { "name": "intEnumVal", "@required": true, "@values": ["LOW", "MEDIUM", "HIGH"], "@intValueMap": { "LOW": 1, "MEDIUM": 2, "HIGH": 3 } } },
```

- [ ] **Step 2: Regenerate the canonical schema SQL**

Run whatever command produces `fixtures/persistence-conformance/canonical/schema.postgres.sql` from `meta.fitness.json` (per CLAUDE.md, this file is TS-produced and committed) — likely `meta migrate` or a dedicated script; check `fixtures/persistence-conformance/README.md` for the exact regeneration command.
Expected: the regenerated SQL declares `int_enum_val integer NOT NULL CHECK (int_enum_val IN (1, 2, 3))` (naming per this project's `columnNamingStrategy`).

- [ ] **Step 3: Add the round-trip scenario**

Edit `fixtures/persistence-conformance/queries/roundtrip-all-types.yaml` — add `intEnumVal` to the existing `insert:`/`expect:` blocks (research found them at lines 74/98) as a sibling key:

```yaml
insert:
  enumVal: "MEDIUM"
  intEnumVal: "MEDIUM"
expect:
  enumVal: "MEDIUM"
  intEnumVal: "MEDIUM"
```

(The wire value is the member STRING on both insert and expect, per this design's D6/D2 — the DB stores `2`, but every port's runtime translates transparently.)

- [ ] **Step 4: Run TS's real-engine round-trip test**

Run: `cd server/typescript && bun test packages/migrate-ts -t roundtrip` (or whichever package actually runs the `persistence-conformance` corpus against TS — check `fixtures/persistence-conformance/README.md` for the exact per-port runner)
Expected: PASS — `intEnumVal: "MEDIUM"` round-trips through insert → Postgres `2` → decoded back to `"MEDIUM"` on read.

- [ ] **Step 5: Commit**

```bash
git add fixtures/persistence-conformance/canonical/meta.fitness.json fixtures/persistence-conformance/canonical/schema.postgres.sql fixtures/persistence-conformance/queries/roundtrip-all-types.yaml
git commit -m "test(persistence-conformance): int-backed field.enum round-trips through TS's real runtime"
```

---

## After this plan lands

TS is the reference port; the same shape (DDL/column-type dispatch → runtime codec → persistence-conformance round-trip) repeats in the C#, Java+Kotlin, and Python persistence plans, each adapted to that port's own ORM/codec idiom (EF Core `HasConversion`, OMDB `JdbcFieldCodec`/Exposed `customEnumeration`, Python `ObjectManager` coercion). Only TS needed a genuinely new "wire type differs from storage type" pattern — the other ports' `MetaField`-level runtime access already made a symbol↔int translation point available without inventing new template plumbing.
