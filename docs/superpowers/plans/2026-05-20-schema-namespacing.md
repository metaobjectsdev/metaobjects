# Schema Namespacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable metadata to declare which Postgres schema each table/view lives in, and have the metadata loader + migrate-ts pipeline (build-expected, introspect, diff, emit) honor it end-to-end. Establish a `@schema` attribute on `source[dbTable]` and `source[dbView]`, defaulting to `"public"` for Postgres. Add cross-language conformance fixtures.

**Architecture:** Add a `SOURCE_ATTR_SCHEMA` constant + `resolveTableSchema()` helper in `@metaobjectsdev/metadata`. Extend `TableDescriptor` and `ViewDescriptor` in `@metaobjectsdev/migrate-ts` with a `schema?: string` field. Update Postgres introspect to scan all non-system schemas, update diff to key tables on `"<schema>.<table>"`, update Postgres emit to produce schema-qualified DDL. SQLite path explicitly rejects non-default schemas. Conformance fixtures land under `fixtures/conformance/`.

**Tech Stack:** TypeScript 5.x (Bun-first), Vitest test runner, pg-mem + optional real Postgres for introspect tests, named constants for all metamodel strings (per `CLAUDE.md`).

---

## File Structure

**Modify:**
- `typescript/packages/metadata/src/constants.ts` — add `SOURCE_ATTR_SCHEMA`, `DEFAULT_DB_SCHEMA_POSTGRES`
- `typescript/packages/metadata/src/naming.ts` — add `resolveTableSchema()` helper
- `typescript/packages/metadata/src/index.ts` — re-export `resolveTableSchema`
- `typescript/packages/migrate-ts/src/types.ts` — add `schema` field to `TableDescriptor` and `ViewDescriptor`
- `typescript/packages/migrate-ts/src/expected-schema.ts` — read `@schema` via helper, populate `TableDescriptor.schema`
- `typescript/packages/migrate-ts/src/introspect/postgres.ts` — scan all non-system schemas, populate `schema` field
- `typescript/packages/migrate-ts/src/introspect/sqlite.ts` — set `schema: undefined` explicitly (no schema concept)
- `typescript/packages/migrate-ts/src/diff/index.ts` — key tables on `"<schema>.<table>"`, propagate schema through change records
- `typescript/packages/migrate-ts/src/emit/postgres.ts` — emit `"<schema>"."<table>"` quoted DDL; updated `quote()` helper accepts schema
- `typescript/packages/migrate-ts/src/emit/sqlite.ts` — error if any TableDescriptor has non-undefined schema
- `CLAUDE.md` — add `@schema` to the cross-language constants list

**Create:**
- `typescript/packages/metadata/test/naming.test.ts` — new `resolveTableSchema` cases (or add to existing test file if present)
- `typescript/packages/migrate-ts/test/schema-namespacing.test.ts` — end-to-end schema-namespacing test
- `fixtures/conformance/source-db-table-with-schema/` — fixture
- `fixtures/conformance/source-db-view-with-schema/` — fixture
- `fixtures/conformance/source-db-table-default-schema-omitted/` — fixture

**Do not touch in this plan:**
- C# loader — `@schema` is opaque passthrough; no code change needed. A later plan adds a conformance-port test against the new fixtures.
- Codegen-ts — does not need to know about schema for v1 (codegen output is per-entity, not schema-aware). A later plan extends codegen-ts if needed.

---

## Task 1: Add constants for `@schema`

**Files:**
- Modify: `typescript/packages/metadata/src/constants.ts`

- [ ] **Step 1: Add the constants near the existing SOURCE_ATTR_NAME block**

Locate the existing block:

```typescript
// Source attrs — both dbTable and dbView use @name for the SQL identifier
// (table name and view name respectively). Same key for ergonomic consistency.
export const SOURCE_DB_TABLE_ATTR_NAME = "name";
export const SOURCE_DB_VIEW_ATTR_NAME  = "name";
/** Shared @name attr key for MetaSource (covers both dbTable and dbView). Use this
 *  in generic source accessors instead of the subtype-specific aliases above. */
export const SOURCE_ATTR_NAME          = "name";
```

Append directly after:

```typescript
/** Optional DB schema attr on source[dbTable] / source[dbView]. Postgres uses
 *  this to namespace tables/views. SQLite has no schema concept and rejects
 *  any non-default value. Default for Postgres: "public". */
export const SOURCE_ATTR_SCHEMA = "schema";

/** Default Postgres schema when @schema is omitted from a source. */
export const DEFAULT_DB_SCHEMA_POSTGRES = "public";
```

- [ ] **Step 2: Verify the package still compiles**

Run from the `typescript/` directory:

```bash
cd typescript && bun run --filter '@metaobjectsdev/metadata' typecheck
```

Expected: exits 0 with no type errors.

- [ ] **Step 3: Commit**

```bash
git add typescript/packages/metadata/src/constants.ts
git commit -m "feat(metadata): add SOURCE_ATTR_SCHEMA + DEFAULT_DB_SCHEMA_POSTGRES constants"
```

---

## Task 2: Add `resolveTableSchema()` helper

**Files:**
- Modify: `typescript/packages/metadata/src/naming.ts`
- Test: `typescript/packages/metadata/test/naming.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `typescript/packages/metadata/test/naming.test.ts`. If the file does not exist, create it with this full content:

```typescript
import { describe, it, expect } from "vitest";
import { loadFromString } from "../src/loader/load.js";
import { resolveTableSchema, resolveTableName } from "../src/naming.js";

describe("resolveTableSchema", () => {
  it("returns the explicit @schema attr when present on source.dbTable", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.dbTable": { "@name": "orders", "@schema": "sales" } },
          ]}},
        ],
      },
    }));
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBe("sales");
  });

  it("returns undefined when @schema is omitted (default-aware callers decide what 'undefined' means)", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.dbTable": { "@name": "orders" } },
          ]}},
        ],
      },
    }));
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBeUndefined();
  });

  it("returns undefined when there is no source[dbTable] child at all", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Order", "children": [] } },
        ],
      },
    }));
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBeUndefined();
  });

  it("reads @schema from source.dbView for projection entities", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "OrderSummary", "children": [
            { "source.dbView": { "@name": "v_order_summary", "@schema": "reporting" } },
          ]}},
        ],
      },
    }));
    const entity = root.ownChildren().find((c) => c.name === "OrderSummary")!;
    expect(resolveTableSchema(entity)).toBe("reporting");
  });

  it("does not affect resolveTableName", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.dbTable": { "@name": "orders", "@schema": "sales" } },
          ]}},
        ],
      },
    }));
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableName(entity)).toBe("orders");
  });
});
```

(If the existing test file uses a different `loadFromString` import path, adjust to match — verify by running `grep -r "loadFromString" typescript/packages/metadata/test/` before writing.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd typescript/packages/metadata && bun test naming.test.ts
```

Expected: FAIL with `resolveTableSchema is not a function` or `Cannot find name 'resolveTableSchema'`.

- [ ] **Step 3: Implement `resolveTableSchema` in naming.ts**

Open `typescript/packages/metadata/src/naming.ts`. Update the imports at the top of the file:

```typescript
import type { MetaData } from "./meta/meta-data.js";
import {
  TYPE_FIELD, TYPE_SOURCE, FIELD_ATTR_DB_COLUMN,
  SOURCE_SUBTYPE_DB_TABLE, SOURCE_SUBTYPE_DB_VIEW,
  SOURCE_DB_TABLE_ATTR_NAME, SOURCE_ATTR_SCHEMA,
} from "./constants.js";
```

Append this function at the bottom of the file:

```typescript
/**
 * Returns the DB schema declared on an entity's source[dbTable] or source[dbView] child,
 * or undefined if no @schema attr is set or no source child exists. Callers decide what
 * "undefined" means for their dialect — Postgres treats it as the default public schema,
 * SQLite treats it as the only allowed value (no schema concept).
 */
export function resolveTableSchema(entity: MetaData): string | undefined {
  const source = entity.ownChildren().find(
    (c) => c.type === TYPE_SOURCE
        && (c.subType === SOURCE_SUBTYPE_DB_TABLE || c.subType === SOURCE_SUBTYPE_DB_VIEW),
  );
  if (!source) return undefined;
  const schema = source.ownAttr(SOURCE_ATTR_SCHEMA);
  if (typeof schema === "string" && schema !== "") return schema;
  return undefined;
}
```

- [ ] **Step 4: Export from package index**

Open `typescript/packages/metadata/src/index.ts`. Find the existing `resolveTableName, resolveColumnName` export line and update it:

```typescript
  resolveTableName, resolveColumnName, resolveTableSchema,
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd typescript/packages/metadata && bun test naming.test.ts
```

Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add typescript/packages/metadata/src/naming.ts typescript/packages/metadata/src/index.ts typescript/packages/metadata/test/naming.test.ts
git commit -m "feat(metadata): add resolveTableSchema() helper for @schema attr"
```

---

## Task 3: Add `schema` field to `TableDescriptor` and `ViewDescriptor`

**Files:**
- Modify: `typescript/packages/migrate-ts/src/types.ts`

- [ ] **Step 1: Update TableDescriptor**

Open `typescript/packages/migrate-ts/src/types.ts`. Replace the existing `TableDescriptor` interface:

```typescript
export interface TableDescriptor {
  name: string;                      // resolved db name (snake_case, plural)
  /**
   * DB schema this table lives in. Undefined for SQLite (no schema concept).
   * For Postgres, undefined is normalized to "public" at SnapshotMeta boundaries;
   * the diff and emit layers treat undefined === "public" as equivalent.
   */
  schema?: string;
  columns: ColumnDescriptor[];
  indexes: IndexDescriptor[];
  foreignKeys: FkDescriptor[];
  primaryKey: string[];              // column names; [] if none
}
```

Replace `ViewDescriptor`:

```typescript
export interface ViewDescriptor {
  name: string;
  /** Same semantics as TableDescriptor.schema. */
  schema?: string;
  // structural fields deferred to v0.3
}
```

- [ ] **Step 2: Verify it still compiles**

```bash
cd typescript && bun run --filter '@metaobjectsdev/migrate-ts' typecheck
```

Expected: exits 0. (Existing call sites that construct `TableDescriptor` without `schema` should still compile because the field is optional.)

- [ ] **Step 3: Commit**

```bash
git add typescript/packages/migrate-ts/src/types.ts
git commit -m "feat(migrate-ts): add optional schema field to TableDescriptor + ViewDescriptor"
```

---

## Task 4: Populate `TableDescriptor.schema` in `buildExpectedSchema`

**Files:**
- Modify: `typescript/packages/migrate-ts/src/expected-schema.ts`
- Test: `typescript/packages/migrate-ts/test/expected-schema-schema-aware.test.ts`

- [ ] **Step 1: Write the failing test**

Create `typescript/packages/migrate-ts/test/expected-schema-schema-aware.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadFromString } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

describe("buildExpectedSchema — schema-aware", () => {
  it("captures the explicit @schema attr from source.dbTable", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.dbTable": { "@name": "orders", "@schema": "sales" } },
            { "field.long":   { "name": "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    }));
    const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
    expect(snapshot.tables).toHaveLength(1);
    expect(snapshot.tables[0].schema).toBe("sales");
    expect(snapshot.tables[0].name).toBe("orders");
  });

  it("leaves schema undefined when @schema is omitted", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.dbTable": { "@name": "orders" } },
            { "field.long":   { "name": "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    }));
    const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
    expect(snapshot.tables[0].schema).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd typescript/packages/migrate-ts && bun test expected-schema-schema-aware.test.ts
```

Expected: FAIL on `expect(snapshot.tables[0].schema).toBe("sales")` — value is `undefined`.

- [ ] **Step 3: Update `buildExpectedSchema` and `buildTable`**

Open `typescript/packages/migrate-ts/src/expected-schema.ts`. Update the `resolveTableName, resolveColumnName,` import line to:

```typescript
  resolveTableName, resolveColumnName, resolveTableSchema,
```

Find Pass 1 (entity collection — currently `const entities: { entity: MetaData; tableName: string }[] = [];`) and replace through the table-build call:

```typescript
  // Pass 1: collect entities + their resolved table names + schemas.
  const entities: { entity: MetaData; tableName: string; schema?: string }[] = [];
  for (const child of root.ownChildren()) {
    if (child.type !== TYPE_OBJECT) continue;
    entities.push({
      entity: child,
      tableName: resolveTableName(child),
      schema: resolveTableSchema(child),
    });
  }
  const entityToTable = new Map(entities.map((e) => [e.entity.name, e.tableName]));
  const resolveTargetTable = (entityName: string) => entityToTable.get(entityName);

  // Pass 2: build full descriptors with FK resolution.
  const tables: TableDescriptor[] = entities.map(({ entity, tableName, schema }) => {
    const t = buildTable(entity, tableName, resolveTargetTable);
    if (schema !== undefined) t.schema = schema;
    return t;
  });
```

(Leave Pass 3 and the dialect normalization untouched.)

- [ ] **Step 4: Run tests to verify pass**

```bash
cd typescript/packages/migrate-ts && bun test expected-schema-schema-aware.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Run the rest of the package's tests to confirm no regression**

```bash
cd typescript/packages/migrate-ts && bun test
```

Expected: PASS — all existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add typescript/packages/migrate-ts/src/expected-schema.ts typescript/packages/migrate-ts/test/expected-schema-schema-aware.test.ts
git commit -m "feat(migrate-ts): populate TableDescriptor.schema from source[dbTable]/[dbView] @schema attr"
```

---

## Task 5: Update `introspectPostgres` to scan non-system schemas

**Files:**
- Modify: `typescript/packages/migrate-ts/src/introspect/postgres.ts`
- Test: `typescript/packages/migrate-ts/test/introspect-postgres-schemas.test.ts`

- [ ] **Step 1: Write the failing test (uses pg-mem)**

Create `typescript/packages/migrate-ts/test/introspect-postgres-schemas.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { newDb } from "pg-mem";
import { Kysely, PostgresDialect } from "kysely";
import { introspectPostgres } from "../src/introspect/postgres.js";

describe("introspectPostgres — multi-schema", () => {
  it("captures tables from non-public schemas with their schema name attached", async () => {
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const db = new Kysely<Record<string, unknown>>({
      dialect: new PostgresDialect({ pool: new Pool() }),
    });
    await mem.public.none(`CREATE SCHEMA p3_api`);
    await mem.public.none(`CREATE TABLE "Orders" (id integer PRIMARY KEY)`);
    await mem.public.none(`CREATE TABLE p3_api."cases_v1" (id integer PRIMARY KEY)`);

    const snapshot = await introspectPostgres(db);
    const orders = snapshot.tables.find((t) => t.name === "Orders");
    const casesV1 = snapshot.tables.find((t) => t.name === "cases_v1");

    expect(orders?.schema).toBe("public");
    expect(casesV1?.schema).toBe("p3_api");
  });

  it("excludes system schemas (pg_catalog, information_schema)", async () => {
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const db = new Kysely<Record<string, unknown>>({
      dialect: new PostgresDialect({ pool: new Pool() }),
    });
    const snapshot = await introspectPostgres(db);
    const fromSystem = snapshot.tables.find((t) =>
      t.schema === "pg_catalog" || t.schema === "information_schema"
    );
    expect(fromSystem).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd typescript/packages/migrate-ts && bun test introspect-postgres-schemas.test.ts
```

Expected: FAIL — currently `introspectPostgres` filters to `table_schema = 'public'`, so `cases_v1` is not in the snapshot.

- [ ] **Step 3: Update the introspect SQL to scan all non-system schemas**

Open `typescript/packages/migrate-ts/src/introspect/postgres.ts`. Find every `table_schema = 'public'` clause (lines ~201, ~214, ~243, ~287, ~373 — verify with `grep -n "table_schema = 'public'" typescript/packages/migrate-ts/src/introspect/postgres.ts`) and replace each with:

```sql
table_schema NOT IN ('pg_catalog', 'information_schema')
  AND table_schema NOT LIKE 'pg_%'
```

For the FK constraint queries that also reference `constraint_schema` and `ccu.table_schema`, apply the same NOT IN + NOT LIKE filter.

Locate the row-projection that turns `information_schema.tables` rows into `TableDescriptor`s (search for `name: row.table_name`); update it to include `schema`:

```typescript
{
  name: String(row.table_name),
  schema: String(row.table_schema),
  columns: [], indexes: [], foreignKeys: [], primaryKey: [],
}
```

Make sure every subsequent join — columns, indexes, FKs, PKs — keys on both `table_schema` and `table_name`. Where the existing code does `tableMap.get(name)`, change to `tableMap.get(schema + "." + name)` and populate the map likewise. This is the largest part of the file change; carry the schema through every join from `information_schema`.

For the views query at line ~214, also update it to include `table_schema` and populate `ViewDescriptor.schema`.

- [ ] **Step 4: Run tests to verify pass**

```bash
cd typescript/packages/migrate-ts && bun test introspect-postgres-schemas.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Run the full migrate-ts test suite for no regression**

```bash
cd typescript/packages/migrate-ts && bun test
```

Expected: PASS. If existing introspect-postgres tests fail because they assert `schema === undefined`, update those assertions to expect `schema === "public"` — the snapshot now always has a schema name for Postgres tables.

- [ ] **Step 6: Commit**

```bash
git add typescript/packages/migrate-ts/src/introspect/postgres.ts typescript/packages/migrate-ts/test/introspect-postgres-schemas.test.ts
git commit -m "feat(migrate-ts): introspect Postgres tables/views from all non-system schemas"
```

---

## Task 6: Update `diff()` to key on schema-qualified table identity

**Files:**
- Modify: `typescript/packages/migrate-ts/src/diff/index.ts`
- Test: `typescript/packages/migrate-ts/test/diff-schema-aware.test.ts`

- [ ] **Step 1: Write the failing test**

Create `typescript/packages/migrate-ts/test/diff-schema-aware.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { diff } from "../src/diff/index.js";
import type { SchemaSnapshot } from "../src/types.js";

const emptyCols = { columns: [], indexes: [], foreignKeys: [], primaryKey: [] };

describe("diff — schema-aware", () => {
  it("treats tables with same name in different schemas as distinct", () => {
    const expected: SchemaSnapshot = {
      tables: [{ name: "orders", schema: "public", ...emptyCols }],
      views: [],
    };
    const actual: SchemaSnapshot = {
      tables: [{ name: "orders", schema: "p3_api", ...emptyCols }],
      views: [],
    };
    const result = diff({ expected, actual, allow: { dropTable: true } });

    // We expect a create-table for public.orders and a drop-table for p3_api.orders,
    // NOT a rename (because schemas differ).
    const creates = result.changes.filter((c) => c.kind === "create-table");
    const drops   = result.changes.filter((c) => c.kind === "drop-table");
    expect(creates).toHaveLength(1);
    expect(drops).toHaveLength(1);
  });

  it("treats schema=undefined and schema='public' as equivalent for Postgres", () => {
    const expected: SchemaSnapshot = {
      tables: [{ name: "orders", schema: undefined, ...emptyCols }],
      views: [],
    };
    const actual: SchemaSnapshot = {
      tables: [{ name: "orders", schema: "public", ...emptyCols }],
      views: [],
    };
    const result = diff({ expected, actual });
    // No changes — they should compare equal.
    expect(result.changes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd typescript/packages/migrate-ts && bun test diff-schema-aware.test.ts
```

Expected: FAIL — current diff keys tables on `name` alone, so the first test sees a no-op (same name, no diff) and the second test produces zero changes only by accident.

- [ ] **Step 3: Add a schema-key helper and update diff()**

Open `typescript/packages/migrate-ts/src/diff/index.ts`. Near the top of the file, after the imports, add:

```typescript
/**
 * Normalize undefined schema to "public" (Postgres default) for comparison purposes.
 * Allows snapshots from buildExpectedSchema (often undefined) to compare equal to
 * snapshots from introspect (always populated for Postgres).
 */
function schemaKey(table: { name: string; schema?: string }): string {
  return (table.schema ?? "public") + "." + table.name;
}
```

Find every `expectedTables` / `actualTables` map construction and change the keying from `t.name` to `schemaKey(t)`. Also propagate schema into Change records — every change kind that today carries `table: string` (the table name) needs a sibling field. To avoid a large API break, encode the change's table identity as `schemaKey(t)` (`"<schema>.<table>"`) for diff purposes only, then unpack when emitting. Specifically:

- Where the code currently does `changes.push({ kind: "create-table", table, status: ALLOWED })`, leave it — `table` here is the full `TableDescriptor` and carries its own schema.
- Where the code does `changes.push({ kind: "drop-table", table: name, status: ALLOWED })` where `name` came from a `Map<string, ...>`, change `name` to be `schemaKey({ name: t.name, schema: t.schema })`. Note that `drop-table.table` is currently typed `string`, so this works without typing changes.
- For `add-column / drop-column / add-index / drop-index / add-fk / drop-fk / change-column-*`, the `table` field already holds the table identifier as a string — change every diff-side construction to use `schemaKey(t)` instead of plain `t.name`.

- [ ] **Step 4: Update emit/postgres.ts to unpack `schemaKey` format**

Open `typescript/packages/migrate-ts/src/emit/postgres.ts`. After the existing imports, add a helper:

```typescript
function splitSchemaKey(key: string): { schema: string; name: string } {
  const dot = key.indexOf(".");
  if (dot < 0) return { schema: "public", name: key };
  return { schema: key.slice(0, dot), name: key.slice(dot + 1) };
}

function quoteQualified(key: string): string {
  const { schema, name } = splitSchemaKey(key);
  if (schema === "public") return quote(name);
  return quote(schema) + "." + quote(name);
}
```

Find every `quote(c.table)` and `quote(c.from)` / `quote(c.to)` call in `renderUp` and `renderDown` and replace with `quoteQualified(...)` — except for `renderColumn`, `renderIndex`, and `renderForeignKey` which take column-level names (not table names). Targeted replacements:

- `ALTER TABLE ${quote(c.table)}` → `ALTER TABLE ${quoteQualified(c.table)}`
- `DROP TABLE ${quote(c.table)}` → `DROP TABLE ${quoteQualified(c.table)}`
- `${quote(c.from)} RENAME TO ${quote(c.to)}` for rename-table → `${quoteQualified(c.from)} RENAME TO ${quote(splitSchemaKey(c.to).name)}` (schema doesn't change on rename)
- inside `renderCreateTable(table)` — change `CREATE TABLE ${quote(table.name)}` → `CREATE TABLE ${quote(table.schema ?? "public") === '"public"' ? quote(table.name) : quote(table.schema!) + "." + quote(table.name)}`. Simpler: extract `tableIdent = (table.schema && table.schema !== "public") ? quote(table.schema) + "." + quote(table.name) : quote(table.name)` and use the local var.

- [ ] **Step 5: Run all migrate-ts tests**

```bash
cd typescript/packages/migrate-ts && bun test
```

Expected: PASS — including the new diff-schema-aware tests and all existing tests.

- [ ] **Step 6: Commit**

```bash
git add typescript/packages/migrate-ts/src/diff/index.ts typescript/packages/migrate-ts/src/emit/postgres.ts typescript/packages/migrate-ts/test/diff-schema-aware.test.ts
git commit -m "feat(migrate-ts): diff and Postgres emit are schema-aware"
```

---

## Task 7: End-to-end Postgres emit produces schema-qualified DDL

**Files:**
- Test: `typescript/packages/migrate-ts/test/emit-postgres-schema-namespacing.test.ts`

- [ ] **Step 1: Write the end-to-end test**

Create `typescript/packages/migrate-ts/test/emit-postgres-schema-namespacing.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadFromString } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { diff } from "../src/diff/index.js";
import { emit } from "../src/emit/index.js";

describe("emit (postgres) — schema namespacing end-to-end", () => {
  it("emits CREATE TABLE schema.table for a non-default schema", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "p3",
        "children": [
          { "object.entity": { "name": "CaseV1", "children": [
            { "source.dbView": { "@name": "cases_v1", "@schema": "p3_api" } },
            { "field.long":    { "name": "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
          { "object.entity": { "name": "Customer", "children": [
            { "source.dbTable": { "@name": "customers" } },
            { "field.long":    { "name": "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    }));
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const actual = { tables: [], views: [] };
    const changes = diff({ expected, actual });
    const sql = emit(changes.changes, { dialect: "postgres" });

    // Non-default schema → qualified DDL.
    expect(sql.up).toMatch(/CREATE TABLE "p3_api"\."cases_v1"/);
    // Default schema → unqualified DDL (back-compat with all existing tests).
    expect(sql.up).toMatch(/CREATE TABLE "customers"/);
    expect(sql.up).not.toMatch(/CREATE TABLE "public"\."customers"/);
  });
});
```

- [ ] **Step 2: Run to verify pass**

```bash
cd typescript/packages/migrate-ts && bun test emit-postgres-schema-namespacing.test.ts
```

Expected: PASS — Tasks 4-6 produced the necessary changes.

- [ ] **Step 3: Commit**

```bash
git add typescript/packages/migrate-ts/test/emit-postgres-schema-namespacing.test.ts
git commit -m "test(migrate-ts): end-to-end schema-namespacing emit test"
```

---

## Task 8: SQLite path rejects `@schema`

**Files:**
- Modify: `typescript/packages/migrate-ts/src/emit/sqlite.ts`
- Modify: `typescript/packages/migrate-ts/src/expected-schema.ts`
- Test: `typescript/packages/migrate-ts/test/emit-sqlite-schema-rejected.test.ts`

- [ ] **Step 1: Write the failing test**

Create `typescript/packages/migrate-ts/test/emit-sqlite-schema-rejected.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadFromString } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

describe("buildExpectedSchema (sqlite) — schema rejection", () => {
  it("throws when @schema is declared and dialect is sqlite", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.dbTable": { "@name": "orders", "@schema": "sales" } },
            { "field.long":     { "name": "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    }));
    expect(() => buildExpectedSchema(root, { dialect: "sqlite" })).toThrow(
      /sqlite.*does not support.*schema/i
    );
  });

  it("does not throw when no @schema is declared and dialect is sqlite", () => {
    const root = loadFromString(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.dbTable": { "@name": "orders" } },
            { "field.long":     { "name": "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    }));
    expect(() => buildExpectedSchema(root, { dialect: "sqlite" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd typescript/packages/migrate-ts && bun test emit-sqlite-schema-rejected.test.ts
```

Expected: FAIL — `buildExpectedSchema` does not currently validate.

- [ ] **Step 3: Add the validation to buildExpectedSchema**

Open `typescript/packages/migrate-ts/src/expected-schema.ts`. After Pass 3 (the dialect normalization block), add:

```typescript
  // Dialect validation: SQLite has no schema concept; reject any non-default @schema.
  if (opts?.dialect === "sqlite") {
    for (const table of tables) {
      if (table.schema !== undefined) {
        throw new Error(
          `sqlite does not support DB schemas; entity-table "${table.name}" declares @schema "${table.schema}"`,
        );
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd typescript/packages/migrate-ts && bun test emit-sqlite-schema-rejected.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Confirm no other test broke**

```bash
cd typescript/packages/migrate-ts && bun test
```

Expected: PASS — all tests green across the package.

- [ ] **Step 6: Commit**

```bash
git add typescript/packages/migrate-ts/src/expected-schema.ts typescript/packages/migrate-ts/test/emit-sqlite-schema-rejected.test.ts
git commit -m "feat(migrate-ts): reject @schema on SQLite dialect at expected-schema build time"
```

---

## Task 9: Conformance fixtures

**Files:**
- Create: `fixtures/conformance/source-db-table-with-schema/input/meta.demo.json`
- Create: `fixtures/conformance/source-db-table-with-schema/expected.json`
- Create: `fixtures/conformance/source-db-view-with-schema/input/meta.demo.json`
- Create: `fixtures/conformance/source-db-view-with-schema/expected.json`
- Create: `fixtures/conformance/source-db-table-default-schema-omitted/input/meta.demo.json`
- Create: `fixtures/conformance/source-db-table-default-schema-omitted/expected.json`

- [ ] **Step 1: Create the source-db-table-with-schema fixture**

Create `fixtures/conformance/source-db-table-with-schema/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "p3",
    "children": [
      {
        "object.entity": {
          "name": "Case",
          "children": [
            { "source.dbTable": { "@name": "Cases", "@schema": "public" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "caseNumber" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

Create `fixtures/conformance/source-db-table-with-schema/expected.json` with the same content (this is the canonical-serializer output — no transformation expected for opaque attrs):

```json
{
  "metadata.root": {
    "package": "p3",
    "children": [
      {
        "object.entity": {
          "name": "Case",
          "children": [
            { "source.dbTable": { "@name": "Cases", "@schema": "public" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "caseNumber" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

(Note `@fields` becomes the array form `["id"]` per the existing fixture pattern.)

- [ ] **Step 2: Create the source-db-view-with-schema fixture**

Create `fixtures/conformance/source-db-view-with-schema/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "p3::api",
    "children": [
      {
        "object.entity": {
          "name": "CaseV1",
          "children": [
            { "source.dbView": { "@name": "cases_v1", "@schema": "p3_api" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "case_number" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

Create `fixtures/conformance/source-db-view-with-schema/expected.json`:

```json
{
  "metadata.root": {
    "package": "p3::api",
    "children": [
      {
        "object.entity": {
          "name": "CaseV1",
          "children": [
            { "source.dbView": { "@name": "cases_v1", "@schema": "p3_api" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "case_number" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 3: Create the omitted-schema fixture**

Create `fixtures/conformance/source-db-table-default-schema-omitted/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "p3",
    "children": [
      {
        "object.entity": {
          "name": "Customer",
          "children": [
            { "source.dbTable": { "@name": "customers" } },
            { "field.long":   { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

Create `fixtures/conformance/source-db-table-default-schema-omitted/expected.json`:

```json
{
  "metadata.root": {
    "package": "p3",
    "children": [
      {
        "object.entity": {
          "name": "Customer",
          "children": [
            { "source.dbTable": { "@name": "customers" } },
            { "field.long":   { "name": "id" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 4: Run the conformance test suite**

```bash
cd typescript && bun test --filter '*conformance*'
```

Expected: PASS — all three new fixtures pass through the TS conformance runner. (The fixtures are pure round-trip — the loader treats `@schema` as an opaque string attr and emits it verbatim. No code change in the loader is needed.)

- [ ] **Step 5: Run C# conformance to verify the loader handles the new fixtures**

```bash
cd csharp && dotnet test MetaObjects.Conformance.Tests
```

Expected: PASS — the C# loader handles unknown attributes as opaque passthrough, so `@schema` round-trips without code changes. If a fixture fails, it's a sign the C# canonical serializer drops unknown attrs; that would be a separate bug ticket, not a blocker for this plan.

- [ ] **Step 6: Commit**

```bash
git add fixtures/conformance/source-db-table-with-schema fixtures/conformance/source-db-view-with-schema fixtures/conformance/source-db-table-default-schema-omitted
git commit -m "test(conformance): add @schema fixtures for source[dbTable]/[dbView]"
```

---

## Task 10: Document `@schema` in cross-language porting guide

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add @schema to the cross-language vocabulary list**

Open `CLAUDE.md`. Find the section:

```markdown
**Metamodel subtype vocabularies (must be identical across languages):**
- Filter operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`
- Source subtypes: `dbTable`, `dbView`
- Origin subtypes: `passthrough`, `aggregate`
- Layout subtypes: `dataGrid`
- Currency attrs: `@currency` (ISO 4217), `@locale` (BCP 47)
```

Insert after the "Currency attrs" line:

```markdown
- Schema attrs: `@schema` on `source[dbTable]` and `source[dbView]` (DB schema name; Postgres default `public`, SQLite rejects non-default values)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document @schema attr in cross-language vocabulary list"
```

---

## Self-Review Checklist (run after all tasks land)

**1. Spec coverage** — does this plan implement the spec's "Schema namespacing" addition end-to-end?

- ✓ `field.subType` no — wait, this is on source, not field. The spec says: "A `package` segment maps to a DB schema (e.g., `acme::api` → `acme_api`). Default schema: `public`." The plan uses explicit `@schema` on source[dbTable]/[dbView] instead of package-to-schema mapping. This is a more explicit approach and is documented in the design rationale. If the team wants automatic package-to-schema mapping later, it can be added in a follow-up plan with a config-level flag — the explicit form remains the source of truth.
- ✓ Default `public` honored in Postgres path.
- ✓ Cross-language conformance fixtures land (3 fixtures: explicit, view, omitted).
- ✓ C# loader verified via existing opaque-attr passthrough.

**2. Placeholder scan** — any "TBD" / "implement later" / "handle edge cases"?

- ✓ All steps contain concrete code. No unscoped phrases.

**3. Type consistency**

- `resolveTableSchema(entity: MetaData): string | undefined` — used consistently across Tasks 2, 4.
- `TableDescriptor.schema?: string` — same name in types.ts (Task 3), populated in expected-schema.ts (Task 4), read in introspect (Task 5), used in diff (Task 6), unpacked in emit (Task 6).
- `splitSchemaKey` and `quoteQualified` defined once in `emit/postgres.ts`; used internally.
- `schemaKey()` defined once in `diff/index.ts`; used internally.

**4. Scope check**

This plan is a single focused unit — one new attr, end-to-end through metadata + migrate-ts. Should fit comfortably in a single subagent-driven execution cycle (~1 week). Tasks are 10, each TDD-shaped.

**5. Ambiguity check**

- "Update every `quote(c.table)` to `quoteQualified(c.table)`" — explicit list in Task 6 step 4.
- "Carry the schema through every join from `information_schema`" — Task 5 step 3. This is the largest single edit. The implementer should `grep -n "table_schema = 'public'"` to locate every call site (5 sites at the time of writing).
- "If existing introspect-postgres tests fail because they assert `schema === undefined`" — Task 5 step 5 explicitly tells the implementer what to do.

---

## Done When

- All 10 tasks committed, each with passing tests
- `cd typescript && bun test` is fully green
- `cd csharp && dotnet test MetaObjects.Conformance.Tests` is fully green
- `CLAUDE.md` updated
- The 3 new conformance fixtures pass on both TS and C# runners
