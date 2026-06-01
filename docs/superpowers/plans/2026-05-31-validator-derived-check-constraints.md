# Validator-derived CHECK Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive DB CHECK constraints from declared validators (`validator.numeric`, `validator.length`, `validator.regex`) so a validator enforces in both app validation and the database schema, reusing the shipped CHECK pipeline.

**Architecture:** A pure additive change to `migrate-ts`'s `buildChecks` helper in `buildExpectedSchema`. Today `buildChecks` emits one CHECK per `field.enum`; this extends it to ALSO walk each field's effective validators and emit a `CheckDescriptor` per SQL-expressible validator. Everything downstream (`diff`, `emit`, inline-in-`CREATE TABLE`) is untouched — `CheckDescriptor` already flows through it. No metamodel changes (the validator attrs already exist cross-port).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Bun test runner, `@metaobjectsdev/metadata` (`field.validators()`, `MetaValidator`, validator subtype/attr constants).

**Prerequisite:** Plan 6 (enum CHECK) on origin/main — the `CheckDescriptor` pipeline + `buildChecks` helper exist.

**Scope:** validator→CHECK derivation in `buildChecks` for `numeric`/`length`/`regex`. **Out of scope (per spec §8):** free-form `@check` attr; multi-column checks; `validator.array`; existing-table check evolution; regex on SQLite; non-TS-port emission.

**Working directory for all commands:** `server/typescript/packages/migrate-ts`.

---

### Task 1: numeric validator → range CHECK (+ thread dialect into buildChecks)

**Files:**
- Modify: `src/expected-schema.ts`
- Test: `test/validator-check/numeric.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/validator-check/numeric.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ENTITY = (fieldChildren: string) => JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      ...JSON.parse(fieldChildren),
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});
function checks(root: MetaData) {
  return buildExpectedSchema(root, { dialect: "postgres" }).tables[0]!.checks;
}

describe("validator.numeric → CHECK", () => {
  test("@min + @max → single range check", async () => {
    const root = await load(ENTITY(`[{"field.int":{"name":"qty","children":[
      {"validator.numeric":{"name":"r","@min":0,"@max":100}}]}}]`));
    const c = checks(root).find((x) => x.name === "orders_qty_numeric_chk");
    expect(c?.expression).toBe("qty >= 0 AND qty <= 100");
  });
  test("@min only → lower-bound check", async () => {
    const root = await load(ENTITY(`[{"field.int":{"name":"price","children":[
      {"validator.numeric":{"name":"r","@min":0}}]}}]`));
    const c = checks(root).find((x) => x.name === "orders_price_numeric_chk");
    expect(c?.expression).toBe("price >= 0");
  });
  test("@max only → upper-bound check", async () => {
    const root = await load(ENTITY(`[{"field.int":{"name":"pct","children":[
      {"validator.numeric":{"name":"r","@max":100}}]}}]`));
    const c = checks(root).find((x) => x.name === "orders_pct_numeric_chk");
    expect(c?.expression).toBe("pct <= 100");
  });
  test("no validators → no validator check", async () => {
    const root = await load(ENTITY(`[{"field.int":{"name":"plain"}}]`));
    expect(checks(root).some((x) => x.name.includes("_numeric_chk"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/validator-check/numeric.test.ts` (no validator checks derived yet).

- [ ] **Step 3: Implement** — in `src/expected-schema.ts`:

(a) Add imports to the existing `@metaobjectsdev/metadata` import block (near `FIELD_SUBTYPE_ENUM`):

```ts
  VALIDATOR_SUBTYPE_NUMERIC, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_ATTR_PATTERN,
```

(b) Add a `MetaValidator` type import:

```ts
import type { ColumnNamingStrategy, MetaData, MetaObject, MetaRoot, MetaValidator } from "@metaobjectsdev/metadata";
```

(c) Add a per-validator mapper above `buildChecks`:

```ts
/**
 * Map a single declared validator to a DB CHECK descriptor, or null when it has
 * no SQL-expressible form on this dialect. The constraint name is
 * `<table>_<col>_<validator>_chk`. The expression references the resolved physical
 * column name verbatim (matching the enum-check convention).
 */
function validatorCheck(
  v: MetaValidator, col: string, tableName: string, dialect: Dialect,
): CheckDescriptor | null {
  switch (v.subType) {
    case VALIDATOR_SUBTYPE_NUMERIC: {
      const parts: string[] = [];
      if (v.min !== undefined) parts.push(`${col} >= ${v.min}`);
      if (v.max !== undefined) parts.push(`${col} <= ${v.max}`);
      if (parts.length === 0) return null;
      return { name: `${tableName}_${col}_numeric_chk`, expression: parts.join(" AND ") };
    }
    default:
      return null;
  }
}
```

(d) In `buildChecks`, add a `dialect` parameter and, inside the field loop (after the enum block), walk the field's validators:

```ts
function buildChecks(
  entity: MetaObject, tableName: string, strategy: ColumnNamingStrategy, dialect: Dialect,
): CheckDescriptor[] {
  const checks: CheckDescriptor[] = [];
  for (const field of entity.fields()) {
    const col = resolveColumnName(field, strategy);
    // Enum membership check (unchanged).
    if (field.subType === FIELD_SUBTYPE_ENUM) {
      const raw = field.attr(FIELD_ATTR_VALUES);
      if (Array.isArray(raw) && raw.length > 0) {
        const values = raw.map((val) => String(val));
        const expression = `${col} IN (${values.map((val) => `'${val.replace(/'/g, "''")}'`).join(", ")})`;
        checks.push({ name: `${tableName}_${col}_chk`, expression });
      }
    }
    // Validator-derived checks.
    for (const v of field.validators()) {
      const check = validatorCheck(v, col, tableName, dialect);
      if (check) checks.push(check);
    }
  }
  return checks;
}
```

(e) Thread `dialect` to the `buildChecks` call. Find the `checks: buildChecks(entity, tableName, strategy)` line in `buildTable` and add `dialect`: `checks: buildChecks(entity, tableName, strategy, dialect)`. Confirm `buildTable` has `dialect` in scope; if not, thread it from `buildExpectedSchema` (which computes `dialect` at the top) through `buildTable`'s signature to the call.

- [ ] **Step 4: Run → PASS** — `bun test test/validator-check/numeric.test.ts`, then `bun run build` (tsc exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/expected-schema.ts test/validator-check/numeric.test.ts
git commit -m "feat(migrate-ts): derive CHECK from validator.numeric @min/@max"
```

---

### Task 2: length validator @min → length CHECK

**Files:**
- Modify: `src/expected-schema.ts`
- Test: `test/validator-check/length.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/validator-check/length.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ENTITY = (fieldChildren: string) => JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "User", children: [
      { "field.long": { name: "id" } },
      ...JSON.parse(fieldChildren),
      { "source.rdb": { name: "src", "@table": "users" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});
function table(root: MetaData) { return buildExpectedSchema(root, { dialect: "postgres" }).tables[0]!; }

describe("validator.length → CHECK", () => {
  test("@min → length lower-bound check", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"code","children":[
      {"validator.length":{"name":"l","@min":3}}]}}]`));
    const c = table(root).checks.find((x) => x.name === "users_code_length_chk");
    expect(c?.expression).toBe("length(code) >= 3");
  });
  test("@max → VARCHAR(n), NOT a check (no duplication)", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"code","children":[
      {"validator.length":{"name":"l","@max":10}}]}}]`));
    const t = table(root);
    // max becomes the column type bound, not a check
    expect(t.checks.some((x) => x.name.includes("_length_chk"))).toBe(false);
    const col = t.columns.find((c) => c.name === "code")!;
    expect(col.sqlType).toEqual({ kind: "text", maxLength: 10 });
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/validator-check/length.test.ts` (length check not derived).

- [ ] **Step 3: Implement** — add a `case` to `validatorCheck` (before `default`):

```ts
    case VALIDATOR_SUBTYPE_LENGTH: {
      // Only @min needs a CHECK; @max already maps to the column's VARCHAR(n) bound.
      if (v.min === undefined) return null;
      return { name: `${tableName}_${col}_length_chk`, expression: `length(${col}) >= ${v.min}` };
    }
```

- [ ] **Step 4: Run → PASS** — `bun test test/validator-check/length.test.ts`. (If the second test fails because `@max` length does NOT currently map to `VARCHAR(n)`, that mapping is independent of this work — keep the `@min`→check assertion and adjust the `@max` assertion to whatever the existing column-type mapping produces, but do NOT emit a length check for `@max`.)

- [ ] **Step 5: Commit**

```bash
git add src/expected-schema.ts test/validator-check/length.test.ts
git commit -m "feat(migrate-ts): derive length CHECK from validator.length @min"
```

---

### Task 3: regex validator @pattern → CHECK (Postgres only)

**Files:**
- Modify: `src/expected-schema.ts`
- Test: `test/validator-check/regex.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/validator-check/regex.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import type { Dialect } from "../../src/types.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ENTITY = (fieldChildren: string) => JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "User", children: [
      { "field.long": { name: "id" } },
      ...JSON.parse(fieldChildren),
      { "source.rdb": { name: "src", "@table": "users" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});
function checks(root: MetaData, dialect: Dialect) {
  return buildExpectedSchema(root, { dialect }).tables[0]!.checks;
}

describe("validator.regex → CHECK", () => {
  test("postgres: @pattern → ~ check", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"slug","children":[
      {"validator.regex":{"name":"re","@pattern":"^[a-z]+$"}}]}}]`));
    const c = checks(root, "postgres").find((x) => x.name === "users_slug_regex_chk");
    expect(c?.expression).toBe("slug ~ '^[a-z]+$'");
  });
  test("single-quote in pattern is escaped", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"q","children":[
      {"validator.regex":{"name":"re","@pattern":"o'brien"}}]}}]`));
    const c = checks(root, "postgres").find((x) => x.name === "users_q_regex_chk");
    expect(c?.expression).toBe("q ~ 'o''brien'");
  });
  test("sqlite: regex emits NO check (no native regex)", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"slug","children":[
      {"validator.regex":{"name":"re","@pattern":"^[a-z]+$"}}]}}]`));
    expect(checks(root, "sqlite").some((x) => x.name.includes("_regex_chk"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/validator-check/regex.test.ts`.

- [ ] **Step 3: Implement** — add a `case` to `validatorCheck` (before `default`):

```ts
    case VALIDATOR_SUBTYPE_REGEX: {
      // Postgres-only: SQLite has no native regex operator.
      if (dialect === "sqlite" || dialect === "d1") return null;
      const pattern = v.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern !== "string" || pattern.length === 0) return null;
      return {
        name: `${tableName}_${col}_regex_chk`,
        expression: `${col} ~ '${pattern.replace(/'/g, "''")}'`,
      };
    }
```

- [ ] **Step 4: Run → PASS** — `bun test test/validator-check/regex.test.ts`, then `bun run build`.

- [ ] **Step 5: Commit**

```bash
git add src/expected-schema.ts test/validator-check/regex.test.ts
git commit -m "feat(migrate-ts): derive regex CHECK from validator.regex @pattern (postgres)"
```

---

### Task 4: end-to-end + coexistence + full verification

**Files:**
- Test: `test/validator-check/e2e.test.ts`

- [ ] **Step 1: Write the failing test** (passes once Tasks 1–3 land; the integration guard the unit tests don't cover — full `buildExpectedSchema → diff → emit`, plus enum+validator coexistence)

```ts
// test/validator-check/e2e.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ORDER = JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.int": { name: "qty", children: [{ "validator.numeric": { name: "r", "@min": 1 } }] } },
      { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED"] } },
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});

describe("e2e: validator-derived checks in CREATE TABLE", () => {
  test("postgres CREATE TABLE inlines the numeric check exactly once", async () => {
    const expected = buildExpectedSchema(await load(ORDER), { dialect: "postgres" });
    const { up } = emit(await collectChanges(expected), { dialect: "postgres" });
    expect(up).toContain(`CONSTRAINT "orders_qty_numeric_chk" CHECK (qty >= 1)`);
    expect(up.split(`CHECK (qty >= 1)`).length - 1).toBe(1);
  });
  test("enum + validator coexist with distinct names", async () => {
    const t = buildExpectedSchema(await load(ORDER), { dialect: "postgres" }).tables[0]!;
    const names = t.checks.map((c) => c.name).sort();
    expect(names).toEqual(["orders_qty_numeric_chk", "orders_status_chk"]);
  });
});

// create-table against an empty actual yields a create-table carrying the checks
async function collectChanges(expected: ReturnType<typeof buildExpectedSchema>) {
  const r = await diff({ expected, actual: { tables: [], views: [] } });
  return r.changes;
}
```

- [ ] **Step 2: Run → PASS** — `bun test test/validator-check/e2e.test.ts`.

- [ ] **Step 3: Full verification** — `bun test` (all migrate-ts tests + the new `test/validator-check/*`, 0 failures), `bun run build` (tsc exit 0), `bun run typecheck` (exit 0). If `bun run build` reports missing `@metaobjectsdev/metadata` declarations, build `../metadata` first (gitignored, don't commit).

- [ ] **Step 4: Commit**

```bash
git add test/validator-check/e2e.test.ts
git commit -m "test(migrate-ts): e2e validator-derived checks + enum coexistence"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** implements spec §3 mapping (numeric=Task 1, length=Task 2, regex/PG-only=Task 3), §4 naming (`<table>_<col>_<validator>_chk`; enum keeps `_chk`), §7 testing (per-validator + e2e + coexistence + escaping + length-`@max`-no-dup). §6 boundaries (create-time-inline) are inherited unchanged — no diff/emit edits. §8 out-of-scope items are not implemented.
- **Localized change:** only `buildChecks` + the new `validatorCheck` helper in `src/expected-schema.ts`. `diff`/`emit`/`renderCreateTable`/the snapshot are untouched (CheckDescriptor already flows).
- **No metamodel changes:** `@min`/`@max`/`@pattern` + the validator subtypes already exist cross-port — no loader edit, no conformance fixture, no collision with the concurrent validator-parity session.
- **Type/name anchors:** `validatorCheck(v, col, tableName, dialect)` returns `CheckDescriptor | null`; `buildChecks(entity, tableName, strategy, dialect)`; constraint names `<table>_<col>_numeric_chk` / `_length_chk` / `_regex_chk`; enum stays `<table>_<col>_chk`. `MetaValidator` exposes `.min`/`.max` (number|undefined) and `ownAttr(VALIDATOR_ATTR_PATTERN)` (string). `field.validators()` returns effective validators. `Dialect`/`CheckDescriptor` from `src/types.ts`.
- **Column quoting:** the expression uses the bare resolved column name (matching the existing enum check's `${col} IN (...)` convention). Mixed-case quoting is a pre-existing cross-cutting concern for ALL checks, not introduced here.
