# Source v2 + persistence + reserved-word enforcement — Stage 1 (TypeScript) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `source` v2 metamodel (paradigm subtype `source.rdb` + `@kind`/`@role`/`@table`/`@schema`, field `@column`), `ERR_RESERVED_ATTR` enforcement, multi-source one-primary validation, and the relationship `@onDelete`/`@onUpdate` referential-action attrs — across the TypeScript reference (loader + corpus + codegen/runtime/migrate consumers), with Java/Python/C# gated in their conformance ledgers.

**Architecture:** Two mergeable units. **Unit 1 (1a+1b+1c) is an atomic cutover** — dropping the `dbTable`/`dbView` subtype constants ripples through `metadata`, `codegen-ts`, `runtime-ts`, `cli`, and `migrate-ts` (all import them), so the corpus migration, the loader, and every consumer must land together to keep `cd server/typescript && bun test` + `bun run --filter '*' typecheck` green. Internally Unit 1 is built **additively first** (register `source.rdb` alongside `dbTable`/`dbView`, add `@column` alongside `@dbColumn`) so most intermediate commits stay green, then the old vocabulary is dropped in one final task. **Unit 2 (1d) is additive** — it threads the new relationship `@onDelete`/`@onUpdate` into the existing `migrate-ts` `FkDescriptor` (the `FkAction` union, DDL emit, introspect, diff already exist).

**Tech Stack:** TypeScript (ESM, Bun test runner), `@metaobjectsdev/metadata` loader, ts-poet codegen, Kysely/Drizzle runtime, the cross-language conformance corpus at `fixtures/conformance/`.

**Decided defaults (from the rollout plan — honored, not re-litigated):**
- `@onDelete` defaults from relationship subtype: composition→`cascade`, aggregation→`set-null`, association→`restrict`. `@onUpdate` default `cascade`. Value set = the existing `FkAction` union `cascade | set-null | restrict | no-action` (kebab-case, no `setDefault`).
- Gating: referential actions + `@storage` round-trip in the shared corpus; physical-type escape hatches are codegen-only. C# is **held** (gated in its ledger); Java has **no** conformance ledger on `main` (nothing to gate). Python gated until Stage 3.
- Scope is exactly source v2 + `@dbColumn`→`@column` + `ERR_RESERVED_ATTR` + referential actions. The broader persistence-vocab normalization (`@indexed`, `@softDelete`, `@version`, `@enforce`/`@fetch` promotion) is **out of scope** for Stage 1.

---

## Key facts discovered (read before starting)

**Loader (`packages/metadata/src/`):**
- Source constants: `persistence/source/source-constants.ts` — `SOURCE_SUBTYPE_DB_TABLE="dbTable"`, `SOURCE_SUBTYPE_DB_VIEW="dbView"`, `SOURCE_SUBTYPES`, `SOURCE_DB_TABLE_ATTR_NAME`/`SOURCE_DB_VIEW_ATTR_NAME`/`SOURCE_ATTR_NAME` (all `"name"`), `SOURCE_ATTR_SCHEMA="schema"`, `DEFAULT_DB_SCHEMA_POSTGRES="public"`.
- `MetaSource` (`persistence/source/meta-source.ts`): `sourceName` (reads `SOURCE_ATTR_NAME`), `isWritable()` (`subType===dbTable`), `isReadOnly()` (`subType===dbView`).
- Registration: `core-types.ts` loops `SOURCE_SUBTYPES`, registering each with `[wildcard(TYPE_ATTR)]` child rule and empty own attrs. `persistence/db/db-provider.ts` then `registry.extend`s `dbTable`/`dbView` with `sourceNameSchema` (`@name`) and extends every `FIELD_SUBTYPE` with `dbColumnSchema`/`dbIndexedSchema`.
- Schemas: `persistence/db/db-schema.ts` has `sourceNameSchema` (`name: SOURCE_ATTR_NAME`), `dbColumnSchema` (`name: FIELD_ATTR_DB_COLUMN`), `dbIndexedSchema`. `persistence/db/db-constants.ts`: `FIELD_ATTR_DB_COLUMN="dbColumn"`, `FIELD_ATTR_DB_INDEXED="db.indexed"`.
- Parser: `parser-core.ts` `applyInlineAttrsAndUnknownKeys` (line ~558) — non-`@` non-reserved key → `ERR_UNKNOWN_ATTR`; `@`-prefixed → `materializeAttr`. **The `ERR_RESERVED_ATTR` hook point is at line ~582**, right after `const attrName = key.slice(ATTR_PREFIX.length);` — if `RESERVED_KEYS.has(attrName)`, emit `ERR_RESERVED_ATTR` and `continue`.
- `RESERVED_KEYS` set: `shared/structural.ts` (name/package/extends/abstract/overlay/isArray/children/value). `ATTR_PREFIX="@"`.
- Validation passes: `loader/meta-data-loader.ts` runs an ordered list (subtype-rules, data-grid sort, filterable-index, origin-paths, data-grid filter, template payloadRef, attr-schema, field-object-storage). New one-primary-source pass slots into this list.
- `AttrSchema` (`registry.ts:32`) supports `allowedValues?: readonly AttrValue[]`, enforced by `attr-schema-validate.ts` → `ERR_BAD_ATTR_VALUE` (pattern: `origin-schema.ts` `@agg`, `template-schema.ts` `@format`).
- Relationship: `core/relationship/relationship-constants.ts` (subtypes association/aggregation/composition + attr constants), `relationship-schema.ts` (`relationshipAttrs`), registered in `core-types.ts`.
- Error codes: `errors.ts` `ERROR_CODES` array — **lacks** `ERR_RESERVED_ATTR`, `ERR_SOURCE_NO_PRIMARY`, `ERR_SOURCE_MULTIPLE_PRIMARY`.
- Canonical serializer: `serializer-json.ts` — fused `type.subType` key, body-key order (name/package/extends/abstract/overlay/isArray/@-attrs-alphabetical/children).

**Consumers:**
- `codegen-ts/src/projection/projection-detector.ts` — `isProjection` (`hasSource(dbView) && !hasSource(dbTable)`), `isWriteThrough` (both). `hasSource` uses `ownChildren()`.
- `codegen-ts/src/projection/extract-view-spec.ts` — `viewName` reads `SOURCE_DB_VIEW_ATTR_NAME`; `sourceColumnNameFor` reads `FIELD_ATTR_DB_COLUMN`.
- `codegen-ts/src/column-mapper.ts` (line ~124) — reads `FIELD_ATTR_DB_COLUMN`.
- `codegen-ts/src/relation-resolver.ts` — references source subtypes (verify usage).
- `metadata/src/core/object/meta-object.ts` `dbTable` getter — finds `source[dbTable]`, reads `SOURCE_DB_TABLE_ATTR_NAME`.
- `metadata/src/naming.ts` — `resolveTableName` (finds `source[dbTable]`, reads name), `resolveColumnName` (reads `FIELD_ATTR_DB_COLUMN`), `resolveTableSchema` (reads `SOURCE_ATTR_SCHEMA`).
- `metadata/src/core/field/meta-field.ts` — `@dbColumn` getter.
- `runtime-ts/src/query-builder.ts`, `drivers/drizzle-driver.ts`, `n2m-resolver.ts` — use `resolveColumnName`/`@dbColumn`.
- `cli/src/lib/projection-migrations.ts` — uses `isProjection`, `resolveTableName`.
- `sdk/src/agent-docs/body.ts` — doc text mentioning `@dbColumn` (update prose only).
- Golden snapshots: `codegen-ts/test/golden/__snapshots__/{sqlite,postgres,package}/` — regenerate with `UPDATE_GOLDEN=1 bun test test/golden/golden-output.test.ts`.

**migrate-ts (`packages/migrate-ts/src/`):**
- `types.ts` — `FkDescriptor { name; columns; refTable; refColumns; onDelete?: FkAction; onUpdate?: FkAction }`; `FkAction = "cascade" | "set-null" | "restrict" | "no-action"`.
- `expected-schema.ts` — `buildForeignKeys` (line ~210) reads `entity.referenceIdentities()` (the `identity.reference` children), checks `.enforce`, constructs `FkDescriptor` **without** `onDelete`/`onUpdate` (line ~241). Imports `SOURCE_SUBTYPE_DB_VIEW` (line 6) to skip projections (line ~66) → must become `@kind`-derived.
- Emit (`emit/postgres.ts` `renderAddFk`, `emit/sqlite.ts` `renderCreateTable`) already render `ON DELETE`/`ON UPDATE` clauses iff `onDelete`/`onUpdate` set, via `fkActionSql`/`renderFkAction`.
- Introspect (`introspect/{postgres,sqlite}.ts`) already reads actions, and **omits `onDelete`/`onUpdate` when the DB value is `no-action`** — so the expected side must likewise omit `no-action` to keep round-trips clean.
- FK/relationship correlation: an entity (e.g. `Week`) carries **both** an `identity.reference` (`@references: "Program"`, the FK carrier) **and** a `relationship.association` (`@objectRef: "Program"`, where `@onDelete`/`@onUpdate` live). Correlate by target-entity name (`MetaReferenceIdentity.targetEntity` ↔ `MetaRelationship.objectRef`).

**Cross-language gating mechanics:**
- TS conformance runner (`metadata/test/conformance.test.ts`) lints expected-error codes against the **TS `ERROR_CODES` constant** → add the 3 codes to `errors.ts`.
- C# conformance runner loads its lint registry from the **shared `fixtures/conformance/ERROR-CODES.json`** → add the 3 codes there too. C# conformance pass/fail on v2 fixtures is gated by `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`.
- Python conformance runner does **not** registry-lint codes — ledger gating in `server/python/tests/conformance/conformance-expected-failures.json` fully covers it.
- Java has **no** conformance ledger on `main` — nothing to gate.

---

## Test harness idiom (AUTHORITATIVE — all loader tests below use this)

The verified loader idiom (confirmed against `metadata/test/field-enum.test.ts`). The per-task test sketches show a `load`/`loadOne` helper for readability — **implement that helper with this exact shape** (async; `load()` takes `InMemorySource[]`; result is `{ root, errors }`; `errors` is `Error[]` whose concrete instances carry `.code`):

```ts
import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemorySource(JSON.stringify(doc))]);
}
const codesOf = (errors: readonly Error[]) =>
  errors.map((e) => (e as { code?: string }).code);
```

- Happy path: `const { root, errors } = await loadDoc(...); expect(errors).toHaveLength(0);`
- Error case: `const { errors } = await loadDoc(...); expect(codesOf(errors)).toContain("ERR_…");`
- Negative (must NOT contain): `expect(codesOf(errors)).not.toContain("ERR_…");`
- Tree access: `root.objects()` returns `MetaObject[]`; `obj.fields()`, `obj.ownChildren()`, `obj.referenceIdentities()`, `obj.relationships()` per the discovered accessors.
- For migrate-ts tests, import `MetaDataLoader`/`InMemorySource` from `@metaobjectsdev/metadata` (confirm both are barrel-exported; add the export if `InMemorySource` is missing).

> Wherever a task sketch shows `loadFromObjects(...)`, `res.errors`, `.map((e) => e.code)`, or `expect(res.errors).toEqual([])`, treat it as shorthand for this idiom (`loadDoc` / `codesOf` / `toHaveLength(0)`).

---

# UNIT 1 — Source v2 cutover (1a + 1b + 1c)

**Atomic unit.** At unit completion: `cd server/typescript && bun test` green (2332+ tests), `bun run --filter '*' typecheck` green, conformance corpus migrated + gated. Then `review + simplify`, merge forward to `main`, push.

Build order is additive-first (Tasks 1–6 keep old vocab) → migrate fixtures (Tasks 7–8) → drop old vocab (Task 9).

> **Execution-time reorder (recorded 2026-05-24):** Task 4 (`ERR_RESERVED_ATTR` enforcement) and Task 7 (corpus migration) are SWAPPED in execution. The rollout plan's qualifier — "land `ERR_RESERVED_ATTR` … safe once `@name` is gone" — means enforcement should land *after* the corpus migration removes `@name`-on-source. Executing in the originally written order forces a registry-exception hack or transient red on every v1 source fixture. New executed order within Unit 1: **1, 2, 3, 5, 6, 7, 4, 8, 9.** The new conformance fixture `error-reserved-word-as-attr` is authored in (the now-later) Task 4 alongside the parser enforcement, not in Task 7.

---

### Task 1: Source v2 + error-code constants (additive)

**Files:**
- Modify: `server/typescript/packages/metadata/src/persistence/source/source-constants.ts`
- Modify: `server/typescript/packages/metadata/src/persistence/db/db-constants.ts`
- Modify: `server/typescript/packages/metadata/src/errors.ts`
- Test: `server/typescript/packages/metadata/test/source-v2-constants.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/source-v2-constants.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  SOURCE_SUBTYPE_RDB,
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_ROLE,
  SOURCE_KIND_TABLE,
  SOURCE_KIND_VIEW,
  SOURCE_RDB_KINDS,
  SOURCE_READ_ONLY_KINDS,
  DEFAULT_SOURCE_KIND,
  SOURCE_ROLE_PRIMARY,
  SOURCE_ROLES,
  DEFAULT_SOURCE_ROLE,
} from "../src/persistence/source/source-constants.js";
import { FIELD_ATTR_COLUMN } from "../src/persistence/db/db-constants.js";
import { ERROR_CODES } from "../src/errors.js";

describe("source v2 constants", () => {
  test("rdb subtype + physical/kind/role attr keys", () => {
    expect(SOURCE_SUBTYPE_RDB).toBe("rdb");
    expect(SOURCE_ATTR_TABLE).toBe("table");
    expect(SOURCE_ATTR_KIND).toBe("kind");
    expect(SOURCE_ATTR_ROLE).toBe("role");
  });

  test("rdb kinds + read-only derivation", () => {
    expect(DEFAULT_SOURCE_KIND).toBe(SOURCE_KIND_TABLE);
    expect(SOURCE_RDB_KINDS).toContain(SOURCE_KIND_TABLE);
    expect(SOURCE_RDB_KINDS).toContain(SOURCE_KIND_VIEW);
    expect(SOURCE_READ_ONLY_KINDS.has(SOURCE_KIND_VIEW)).toBe(true);
    expect(SOURCE_READ_ONLY_KINDS.has(SOURCE_KIND_TABLE)).toBe(false);
  });

  test("roles + default primary", () => {
    expect(DEFAULT_SOURCE_ROLE).toBe(SOURCE_ROLE_PRIMARY);
    expect(SOURCE_ROLES).toContain(SOURCE_ROLE_PRIMARY);
  });

  test("field @column key", () => {
    expect(FIELD_ATTR_COLUMN).toBe("column");
  });

  test("new error codes registered", () => {
    expect(ERROR_CODES).toContain("ERR_RESERVED_ATTR");
    expect(ERROR_CODES).toContain("ERR_SOURCE_NO_PRIMARY");
    expect(ERROR_CODES).toContain("ERR_SOURCE_MULTIPLE_PRIMARY");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/source-v2-constants.test.ts`
Expected: FAIL — `SOURCE_SUBTYPE_RDB` / `FIELD_ATTR_COLUMN` not exported.

- [ ] **Step 3: Add the constants (additive — keep dbTable/dbView for now)**

In `source-constants.ts`, **add** (do not yet remove `SOURCE_SUBTYPE_DB_TABLE`/`DB_VIEW`):

```ts
// --- Source v2 (ADR-0007): paradigm subtype "rdb"; physical name @table; @kind + @role. ---
export const SOURCE_SUBTYPE_RDB = "rdb";

/** Physical table/view name on source.rdb (replaces the v1 @name). */
export const SOURCE_ATTR_TABLE = "table";
/** Object kind within the rdb paradigm; read-only-ness is derived from it. */
export const SOURCE_ATTR_KIND = "kind";
/** Multi-source role; exactly one primary per object. */
export const SOURCE_ATTR_ROLE = "role";

export const SOURCE_KIND_TABLE = "table";
export const SOURCE_KIND_VIEW = "view";
export const SOURCE_KIND_MATERIALIZED_VIEW = "materializedView";
export const SOURCE_KIND_STORED_PROC = "storedProc";
export const SOURCE_KIND_TABLE_FUNCTION = "tableFunction";

export const SOURCE_RDB_KINDS = [
  SOURCE_KIND_TABLE,
  SOURCE_KIND_VIEW,
  SOURCE_KIND_MATERIALIZED_VIEW,
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
] as const;
export type SourceRdbKind = (typeof SOURCE_RDB_KINDS)[number];

/** rdb @kind default when omitted (writable table). */
export const DEFAULT_SOURCE_KIND = SOURCE_KIND_TABLE;

/** Kinds whose source is read-only (codegen emits read-only model/queries/routes). */
export const SOURCE_READ_ONLY_KINDS: ReadonlySet<string> = new Set([
  SOURCE_KIND_VIEW,
  SOURCE_KIND_MATERIALIZED_VIEW,
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
]);

export const SOURCE_ROLE_PRIMARY = "primary";
export const SOURCE_ROLE_REPLICA = "replica";
export const SOURCE_ROLE_INDEX = "index";
export const SOURCE_ROLE_CACHE = "cache";
export const SOURCE_ROLE_PUBLISH = "publish";
export const SOURCE_ROLE_MIRROR = "mirror";

export const SOURCE_ROLES = [
  SOURCE_ROLE_PRIMARY,
  SOURCE_ROLE_REPLICA,
  SOURCE_ROLE_INDEX,
  SOURCE_ROLE_CACHE,
  SOURCE_ROLE_PUBLISH,
  SOURCE_ROLE_MIRROR,
] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

/** Role when @role is omitted (system of record). */
export const DEFAULT_SOURCE_ROLE = SOURCE_ROLE_PRIMARY;
```

In `db-constants.ts`, **add** `export const FIELD_ATTR_COLUMN = "column";` (keep `FIELD_ATTR_DB_COLUMN` for now).

In `errors.ts`, add to the `ERROR_CODES` array: `"ERR_RESERVED_ATTR"`, `"ERR_SOURCE_NO_PRIMARY"`, `"ERR_SOURCE_MULTIPLE_PRIMARY"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/source-v2-constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/persistence/source/source-constants.ts \
        server/typescript/packages/metadata/src/persistence/db/db-constants.ts \
        server/typescript/packages/metadata/src/errors.ts \
        server/typescript/packages/metadata/test/source-v2-constants.test.ts
git commit -m "feat(metadata): add source-v2 + error-code constants (additive)"
```

---

### Task 2: Register `source.rdb` + schemas; `@kind`-derived read-only on MetaSource

**Files:**
- Modify: `server/typescript/packages/metadata/src/persistence/source/meta-source.ts`
- Create: `server/typescript/packages/metadata/src/persistence/source/source-schema.ts`
- Modify: `server/typescript/packages/metadata/src/core-types.ts`
- Modify: `server/typescript/packages/metadata/src/persistence/db/db-provider.ts`
- Test: `server/typescript/packages/metadata/test/source-rdb.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/source-rdb.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import { MetaSource } from "../src/persistence/source/meta-source.js";

function loadOne(json: unknown) {
  const loader = new MetaDataLoader();
  const res = loader.loadFromObjects([{ name: "m.json", data: json }]);
  return res;
}

describe("source.rdb registration", () => {
  const meta = {
    "metadata.root": {
      package: "acme",
      children: [
        { "object.entity": { name: "Product", children: [
          { "source.rdb": { "@table": "products", "@schema": "catalog" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { "@fields": "id" } },
        ] } },
        { "object.entity": { name: "ProductView", extends: "Product", children: [
          { "source.rdb": { "@table": "v_product", "@kind": "view" } },
          { "identity.primary": { "@fields": "id" } },
        ] } },
      ],
    },
  };

  test("loads with no errors and round-trips @table/@kind/@schema", () => {
    const res = loadOne(meta);
    expect(res.errors).toEqual([]);
    const out = canonicalSerialize(res.root);
    expect(out).toContain('"source.rdb"');
    expect(out).toContain('"@table": "products"');
    expect(out).toContain('"@schema": "catalog"');
    expect(out).toContain('"@kind": "view"');
  });

  test("MetaSource derives read-only from @kind (default table = writable)", () => {
    const res = loadOne(meta);
    const product = res.root.objects().find((o) => o.name === "Product")!;
    const view = res.root.objects().find((o) => o.name === "ProductView")!;
    const productSrc = product.ownChildren().find((c) => c instanceof MetaSource) as MetaSource;
    const viewSrc = view.ownChildren().find((c) => c instanceof MetaSource) as MetaSource;
    expect(productSrc.effectiveKind).toBe("table");
    expect(productSrc.isReadOnly()).toBe(false);
    expect(productSrc.tableName).toBe("products");
    expect(productSrc.role).toBe("primary");
    expect(viewSrc.effectiveKind).toBe("view");
    expect(viewSrc.isReadOnly()).toBe(true);
  });

  test("bad @kind / @role value → ERR_BAD_ATTR_VALUE", () => {
    const bad = {
      "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "X", children: [
          { "source.rdb": { "@table": "x", "@kind": "bogus" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { "@fields": "id" } },
        ] } },
      ] },
    };
    const res = loadOne(bad);
    expect(res.errors.map((e) => e.code)).toContain("ERR_BAD_ATTR_VALUE");
  });
});
```

> NOTE for the implementer: confirm the exact loader entry point and result shape (`loadFromObjects` vs `loadFromDirectory`; `res.errors` element type — `{code}` objects or strings) by reading an existing loader test (e.g. `metadata/test/loader-*.test.ts`) and match it. Adjust the harness helper accordingly; the assertions on canonical output + MetaSource accessors are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/source-rdb.test.ts`
Expected: FAIL — `source.rdb` is an unknown subtype (`ERR_UNKNOWN_SUBTYPE`), `effectiveKind`/`tableName`/`role` not on `MetaSource`.

- [ ] **Step 3: Create the rdb attr schemas**

Create `server/typescript/packages/metadata/src/persistence/source/source-schema.ts`:

```ts
// source.rdb attr schemas (ADR-0007 / ADR-0004 per-subtype attrs).
import type { AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_STRING } from "../../shared/attr-subtypes.js"; // confirm this constant's module
import {
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_ROLE,
  SOURCE_ATTR_SCHEMA,
  SOURCE_RDB_KINDS,
  SOURCE_ROLES,
} from "./source-constants.js";

/** `@table` — physical table/view name on source.rdb (derived from name when omitted). */
export const sourceTableSchema: AttrSchema = {
  name: SOURCE_ATTR_TABLE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description: "Physical table/view name for this rdb source. Defaults to the object name via columnNamingStrategy.",
};

/** `@kind` — rdb object kind; read-only-ness derived from it. */
export const sourceKindSchema: AttrSchema = {
  name: SOURCE_ATTR_KIND,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  allowedValues: [...SOURCE_RDB_KINDS],
  description: "rdb object kind (table*/view/materializedView/storedProc/tableFunction). Default table.",
};

/** `@role` — multi-source role; exactly one primary per object. */
export const sourceRoleSchema: AttrSchema = {
  name: SOURCE_ATTR_ROLE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  allowedValues: [...SOURCE_ROLES],
  description: "Multi-source role (primary*/replica/index/cache/publish/mirror).",
};

/** `@schema` — Postgres schema/namespace; SQLite rejects non-default. */
export const sourceSchemaSchema: AttrSchema = {
  name: SOURCE_ATTR_SCHEMA,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description: "DB schema/namespace for this source (Postgres default public).",
};

export const sourceRdbAttrs: AttrSchema[] = [
  sourceTableSchema,
  sourceKindSchema,
  sourceRoleSchema,
  sourceSchemaSchema,
];
```

> Confirm the `ATTR_SUBTYPE_STRING` import path against `db-schema.ts` (it already imports it) and reuse the same module.

- [ ] **Step 4: Register `source.rdb` in `core-types.ts`**

Add `SOURCE_SUBTYPE_RDB` to the `SOURCE_SUBTYPES` loop's set (it should already include it if you add `SOURCE_SUBTYPE_RDB` to `SOURCE_SUBTYPES` in Task 1 — but Task 1 kept `SOURCE_SUBTYPES` as-is). **Update Task 1's `SOURCE_SUBTYPES`** to additionally include `SOURCE_SUBTYPE_RDB`:

```ts
export const SOURCE_SUBTYPES = [
  SUBTYPE_BASE,
  SOURCE_SUBTYPE_DB_TABLE, // dropped in Task 9
  SOURCE_SUBTYPE_DB_VIEW,  // dropped in Task 9
  SOURCE_SUBTYPE_RDB,
] as const;
```

In `db-provider.ts`, register the rdb attrs (additive — keep the dbTable/dbView extends for now):

```ts
registry.extend(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, { attributes: [...sourceRdbAttrs] });
```

(import `sourceRdbAttrs` from `../source/source-schema.js`, `SOURCE_SUBTYPE_RDB` from `../source/source-constants.js`.)

- [ ] **Step 5: Add `@kind`-derived accessors to `MetaSource`**

In `meta-source.ts`, add (keep `sourceName`/`isWritable`/`isReadOnly` for now; rework `isReadOnly`/`isWritable` to `@kind`):

```ts
import {
  SOURCE_ATTR_TABLE, SOURCE_ATTR_KIND, SOURCE_ATTR_ROLE,
  SOURCE_READ_ONLY_KINDS, DEFAULT_SOURCE_KIND, DEFAULT_SOURCE_ROLE,
  SOURCE_SUBTYPE_RDB,
} from "./source-constants.js";

// ... inside MetaSource:

/** Physical table/view name (@table), or undefined → derive from logical name. */
get tableName(): string | undefined {
  const v = this.ownAttr(SOURCE_ATTR_TABLE);
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Effective @kind (defaults to table for rdb). */
get effectiveKind(): string {
  const v = this.ownAttr(SOURCE_ATTR_KIND);
  return typeof v === "string" && v !== "" ? v : DEFAULT_SOURCE_KIND;
}

/** Multi-source role (defaults to primary). */
get role(): string {
  const v = this.ownAttr(SOURCE_ATTR_ROLE);
  return typeof v === "string" && v !== "" ? v : DEFAULT_SOURCE_ROLE;
}

isReadOnly(): boolean {
  return SOURCE_READ_ONLY_KINDS.has(this.effectiveKind);
}

isWritable(): boolean {
  return !this.isReadOnly();
}
```

> The old subtype-based `isReadOnly`/`isWritable` bodies are replaced here. `sourceName` (reads `@name`) stays until Task 9 (consumers still use it).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server/typescript/packages/metadata && bun test test/source-rdb.test.ts`
Expected: PASS.
Run: `cd server/typescript/packages/metadata && bun test` — expect **still green** (dbTable/dbView untouched; rdb additive).

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/metadata/src/persistence/source/ \
        server/typescript/packages/metadata/src/core-types.ts \
        server/typescript/packages/metadata/src/persistence/db/db-provider.ts \
        server/typescript/packages/metadata/test/source-rdb.test.ts
git commit -m "feat(metadata): register source.rdb + @kind/@role/@table/@schema; @kind-derived read-only"
```

---

### Task 3: Field `@column` attr (additive alongside `@dbColumn`)

**Files:**
- Modify: `server/typescript/packages/metadata/src/persistence/db/db-schema.ts`
- Modify: `server/typescript/packages/metadata/src/persistence/db/db-provider.ts`
- Modify: `server/typescript/packages/metadata/src/naming.ts`
- Modify: `server/typescript/packages/metadata/src/core/field/meta-field.ts`
- Test: `server/typescript/packages/metadata/test/field-column.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { resolveColumnName } from "../src/naming.js";

function load(json: unknown) {
  const loader = new MetaDataLoader();
  return loader.loadFromObjects([{ name: "m.json", data: json }]);
}

describe("field @column", () => {
  const meta = { "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "P", children: [
      { "source.rdb": { "@table": "p" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "firstName", "@column": "first_name" } },
      { "identity.primary": { "@fields": "id" } },
    ] } },
  ] } };

  test("@column round-trips and resolveColumnName prefers it", () => {
    const res = load(meta);
    expect(res.errors).toEqual([]);
    const p = res.root.objects().find((o) => o.name === "P")!;
    const firstName = p.fields().find((f) => f.name === "firstName")!;
    expect(resolveColumnName(firstName)).toBe("first_name");
  });
});
```

> Confirm `p.fields()` / field accessor against existing tests.

- [ ] **Step 2: Run test → FAIL** (`@column` unknown attr → `ERR_UNKNOWN_ATTR`).

Run: `cd server/typescript/packages/metadata && bun test test/field-column.test.ts`

- [ ] **Step 3: Add `@column` schema (additive)**

In `db-schema.ts`, add `columnSchema` mirroring `dbColumnSchema` but `name: FIELD_ATTR_COLUMN`:

```ts
export const columnSchema: AttrSchema = {
  name: FIELD_ATTR_COLUMN,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description: "Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy.",
};
```

In `db-provider.ts`, extend every `FIELD_SUBTYPE` with `columnSchema` too (alongside `dbColumnSchema`).

In `naming.ts` `resolveColumnName`, prefer `@column`, fall back to `@dbColumn`, then naming strategy:

```ts
export function resolveColumnName(field: MetaData): string {
  const col = field.ownAttr(FIELD_ATTR_COLUMN);
  if (typeof col === "string" && col) return col;
  const dbAttr = field.ownAttr(FIELD_ATTR_DB_COLUMN); // dropped in Task 9
  if (typeof dbAttr === "string" && dbAttr) return dbAttr;
  return columnNameFromField(field.name);
}
```

In `meta-field.ts`, add a `column` getter (reads `@column`, falls back to `@dbColumn`).

- [ ] **Step 4: Run test → PASS.** Run full metadata suite — still green.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/persistence/db/db-schema.ts \
        server/typescript/packages/metadata/src/persistence/db/db-provider.ts \
        server/typescript/packages/metadata/src/naming.ts \
        server/typescript/packages/metadata/src/core/field/meta-field.ts \
        server/typescript/packages/metadata/test/field-column.test.ts
git commit -m "feat(metadata): add field @column attr (additive; resolveColumnName prefers it)"
```

---

### Task 4: `ERR_RESERVED_ATTR` parser enforcement

**Files:**
- Modify: `server/typescript/packages/metadata/src/parser-core.ts`
- Test: `server/typescript/packages/metadata/test/reserved-attr.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";

function load(json: unknown) {
  const loader = new MetaDataLoader();
  return loader.loadFromObjects([{ name: "m.json", data: json }]);
}

describe("ERR_RESERVED_ATTR", () => {
  test("@isArray (reserved word as @-attr) → ERR_RESERVED_ATTR", () => {
    const res = load({ "metadata.root": { package: "acme", children: [
      { "object.value": { name: "V", children: [
        { "field.object": { name: "posts", "@isArray": true, "@objectRef": "V" } },
      ] } },
    ] } });
    expect(res.errors.map((e) => e.code)).toContain("ERR_RESERVED_ATTR");
  });

  test("bare isArray (structural) is accepted", () => {
    const res = load({ "metadata.root": { package: "acme", children: [
      { "object.value": { name: "V", children: [
        { "field.string": { name: "x" } },
        { "field.object": { name: "posts", isArray: true, "@objectRef": "V" } },
      ] } },
    ] } });
    expect(res.errors.map((e) => e.code)).not.toContain("ERR_RESERVED_ATTR");
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`@isArray` currently parsed as an attr named `isArray`, no error).

- [ ] **Step 3: Add the reserved-attr check in `applyInlineAttrsAndUnknownKeys`**

In `parser-core.ts`, immediately after `const attrName = key.slice(ATTR_PREFIX.length);` (line ~582):

```ts
if (RESERVED_KEYS.has(attrName)) {
  const displayName =
    model.name !== "" ? `${model.type}.${model.subType} '${model.name}'` : `${model.type}.${model.subType}`;
  reportProblem(
    `Reserved structural key '${attrName}' must not be ${ATTR_PREFIX}-prefixed on ${displayName} at ${path} (write it bare)`,
    strict, warnings, source, path, "ERR_RESERVED_ATTR",
  );
  continue;
}
```

(`RESERVED_KEYS` is already imported in `parser-core.ts`.)

- [ ] **Step 4: Run test → PASS.** Run full metadata suite — **expect failures** in any test/fixture still using `@isArray` (e.g. the in-repo `origin-collection-simple` corpus fixture is loaded by conformance). Those are fixed in Tasks 7–8; note them and proceed. If a *unit* test in the metadata package itself uses `@isArray`, fix it now to bare `isArray`.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/parser-core.ts \
        server/typescript/packages/metadata/test/reserved-attr.test.ts
git commit -m "feat(metadata): enforce ERR_RESERVED_ATTR (reserved word as @-attr)"
```

---

### Task 5: One-primary multi-source validation

**Files:**
- Create: `server/typescript/packages/metadata/src/persistence/source/validate-source-roles.ts`
- Modify: `server/typescript/packages/metadata/src/loader/meta-data-loader.ts`
- Test: `server/typescript/packages/metadata/test/source-roles-validation.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";

function load(json: unknown) {
  return new MetaDataLoader().loadFromObjects([{ name: "m.json", data: json }]);
}
const entity = (sources: unknown[]) => ({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "P", children: [
    ...sources,
    { "field.long": { name: "id" } },
    { "identity.primary": { "@fields": "id" } },
  ] } },
] } });

describe("one-primary source validation", () => {
  test("single source (default role primary) → OK", () => {
    const res = load(entity([{ "source.rdb": { "@table": "p" } }]));
    expect(res.errors).toEqual([]);
  });

  test("primary + replica (explicit) → OK", () => {
    const res = load(entity([
      { "source.rdb": { "@table": "p" } },
      { "source.rdb": { "@table": "v_p", "@kind": "view", "@role": "replica" } },
    ]));
    expect(res.errors).toEqual([]);
  });

  test("zero sources → OK (not all objects persist)", () => {
    const res = load({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "P", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": "id" } },
      ] } },
    ] } });
    expect(res.errors).toEqual([]);
  });

  test("no primary (only replica) → ERR_SOURCE_NO_PRIMARY", () => {
    const res = load(entity([{ "source.rdb": { "@table": "p", "@role": "replica" } }]));
    expect(res.errors.map((e) => e.code)).toContain("ERR_SOURCE_NO_PRIMARY");
  });

  test("two primaries → ERR_SOURCE_MULTIPLE_PRIMARY", () => {
    const res = load(entity([
      { "source.rdb": { "@table": "p" } },
      { "source.rdb": { "@table": "q" } },
    ]));
    expect(res.errors.map((e) => e.code)).toContain("ERR_SOURCE_MULTIPLE_PRIMARY");
  });
});
```

- [ ] **Step 2: Run test → FAIL** (no validation; multi-primary/no-primary load clean).

- [ ] **Step 3: Implement the validation pass**

Create `validate-source-roles.ts`. Walk every object; among its `MetaSource` children (use `ownChildren()` + `instanceof MetaSource`; only objects that declare ≥1 source are checked); count `role === primary`. `0` → `ERR_SOURCE_NO_PRIMARY`; `>1` → `ERR_SOURCE_MULTIPLE_PRIMARY`. Return an error array shaped like the other passes (read an existing pass, e.g. `validateFieldObjectStorage`, for the exact return/error shape + how it walks the tree).

```ts
import type { MetaData } from "./.../meta-data.js"; // match existing import style
import { MetaSource } from "./meta-source.js";
import { SOURCE_ROLE_PRIMARY, DEFAULT_SOURCE_ROLE } from "./source-constants.js";
// import the loader's error helper/type used by sibling passes

export function validateSourceRoles(root: MetaData): /* same error[] type as siblings */ {
  const errors = [];
  for (const obj of root.objects()) {                 // confirm root.objects() exists at this layer
    const sources = obj.ownChildren().filter((c): c is MetaSource => c instanceof MetaSource);
    if (sources.length === 0) continue;
    const primaries = sources.filter((s) => (s.role ?? DEFAULT_SOURCE_ROLE) === SOURCE_ROLE_PRIMARY);
    if (primaries.length === 0) errors.push(/* ERR_SOURCE_NO_PRIMARY on obj */);
    else if (primaries.length > 1) errors.push(/* ERR_SOURCE_MULTIPLE_PRIMARY on obj */);
  }
  return errors;
}
```

Wire it into `meta-data-loader.ts` alongside the other passes (push its errors into the `errors` accumulator).

> Match the exact error-object construction (code + message + source/path) used by `validateFieldObjectStorage` / `validateOriginPaths`. Read one before writing.

- [ ] **Step 4: Run test → PASS.** Full metadata suite green (except known `@isArray` corpus fixture, fixed later).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/persistence/source/validate-source-roles.ts \
        server/typescript/packages/metadata/src/loader/meta-data-loader.ts \
        server/typescript/packages/metadata/test/source-roles-validation.test.ts
git commit -m "feat(metadata): one-primary multi-source validation (ERR_SOURCE_NO_PRIMARY / _MULTIPLE_PRIMARY)"
```

---

### Task 6: Relationship `@onDelete` / `@onUpdate` schema

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/relationship/relationship-constants.ts`
- Modify: `server/typescript/packages/metadata/src/core/relationship/relationship-schema.ts`
- Modify: `server/typescript/packages/metadata/src/core/relationship/meta-relationship.ts`
- Test: `server/typescript/packages/metadata/test/relationship-referential-actions.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { canonicalSerialize } from "../src/serializer-json.js";

function load(json: unknown) {
  return new MetaDataLoader().loadFromObjects([{ name: "m.json", data: json }]);
}

describe("relationship @onDelete/@onUpdate", () => {
  test("valid kebab-case actions round-trip", () => {
    const res = load({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "field.long": { name: "id" } }, { "identity.primary": { "@fields": "id" } } ] } },
      { "object.entity": { name: "Week", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId" } },
        { "relationship.composition": { name: "program", "@objectRef": "Program",
            "@cardinality": "one", "@onDelete": "cascade", "@onUpdate": "cascade" } },
        { "identity.primary": { "@fields": "id" } },
      ] } },
    ] } });
    expect(res.errors).toEqual([]);
    const out = canonicalSerialize(res.root);
    expect(out).toContain('"@onDelete": "cascade"');
    expect(out).toContain('"@onUpdate": "cascade"');
  });

  test("invalid action value → ERR_BAD_ATTR_VALUE", () => {
    const res = load({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Week", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "p", "@objectRef": "X", "@onDelete": "setDefault" } },
        { "identity.primary": { "@fields": "id" } } ] } },
    ] } });
    expect(res.errors.map((e) => e.code)).toContain("ERR_BAD_ATTR_VALUE");
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`@onDelete`/`@onUpdate` unknown → `ERR_UNKNOWN_ATTR`).

- [ ] **Step 3: Add constants + the canonical referential-action set**

In `relationship-constants.ts`:

```ts
export const RELATIONSHIP_ATTR_ON_DELETE = "onDelete";
export const RELATIONSHIP_ATTR_ON_UPDATE = "onUpdate";

/** Referential actions — the canonical cross-language set (kebab-case, no setDefault).
 *  MUST equal migrate-ts's FkAction union (server/typescript/packages/migrate-ts/src/types.ts). */
export const REFERENTIAL_ACTIONS = ["cascade", "set-null", "restrict", "no-action"] as const;
export type ReferentialAction = (typeof REFERENTIAL_ACTIONS)[number];

/** Default @onDelete per relationship subtype (rollout decided defaults). */
export const ON_DELETE_DEFAULT_BY_SUBTYPE: Readonly<Record<string, ReferentialAction>> = {
  [RELATIONSHIP_SUBTYPE_COMPOSITION]: "cascade",
  [RELATIONSHIP_SUBTYPE_AGGREGATION]: "set-null",
  [RELATIONSHIP_SUBTYPE_ASSOCIATION]: "restrict",
};
export const ON_UPDATE_DEFAULT: ReferentialAction = "cascade";
```

(Ensure `RELATIONSHIP_SUBTYPE_*` are defined above these in the same file.)

- [ ] **Step 4: Add the attr schemas**

In `relationship-schema.ts`, append to `relationshipAttrs`:

```ts
{
  name: RELATIONSHIP_ATTR_ON_DELETE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  allowedValues: [...REFERENTIAL_ACTIONS],
  description: "Referential action on parent delete. Default derives from subtype (composition→cascade, aggregation→set-null, association→restrict).",
},
{
  name: RELATIONSHIP_ATTR_ON_UPDATE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  allowedValues: [...REFERENTIAL_ACTIONS],
  description: "Referential action on key update. Default cascade.",
},
```

In `meta-relationship.ts`, add `onDelete`/`onUpdate` getters (raw attr value or undefined).

- [ ] **Step 5: Run test → PASS.** Full metadata suite green (except known `@isArray` fixture).

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/core/relationship/ \
        server/typescript/packages/metadata/test/relationship-referential-actions.test.ts
git commit -m "feat(metadata): relationship @onDelete/@onUpdate schema (allowedValues = FkAction)"
```

---

### Task 7: Migrate the conformance corpus to source v2 + add new fixtures + gate ledgers

**Files (corpus — repo-root `fixtures/conformance/`):**
- Modify `input/*.json` + `expected.json` for every source/origin/storage fixture (full list below).
- Fix `origin-collection-simple` `@isArray`→bare `isArray`.
- Create new fixtures: `error-reserved-word-as-attr`, `source-rdb-referential-actions`, `source-multi-source-roles`, `error-source-no-primary`, `error-source-multiple-primary`, `source-rdb-column` (field `@column`).
- Modify `fixtures/conformance/ERROR-CODES.json`.
- Modify `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`.
- Modify `server/python/tests/conformance/conformance-expected-failures.json`.

**Transformation rules (deterministic):**
1. `{ "source.dbTable": { "@name": "X", ...rest } }` → `{ "source.rdb": { "@table": "X", ...rest } }` (drop nothing else; `@schema` stays).
2. `{ "source.dbView": { "@name": "X", ...rest } }` → `{ "source.rdb": { "@kind": "view", "@table": "X", ...rest } }`.
3. Field `"@dbColumn": "c"` → `"@column": "c"` (none currently in the corpus, but apply if found).
4. `"@isArray": true` → `"isArray": true` (bare structural; only `origin-collection-simple`).
5. Regenerate each `expected.json` from canonical output. **Canonical body-key order:** within a `source.rdb` body, `@`-attrs are alphabetical → `@kind` before `@schema` before `@table`. `isArray` (structural) sorts to position 6, **before** all `@`-attrs.

**Migrated fixtures (the complete list):**
`source-db-table-explicit`, `source-db-table-default-schema-omitted`, `source-db-table-with-schema`, `source-db-view-projection`, `source-db-view-with-schema`, `origin-passthrough-simple`, `origin-aggregate-count`, `origin-aggregate-sum`, `origin-multi-level-via`, `error-origin-bad-aggregate-fn`, `error-origin-bad-via-path`, `field-object-storage-jsonb-single`, `field-object-storage-jsonb-array`, `field-object-storage-flattened`, `field-object-storage-flattened-nullable`, `error-field-object-storage-flattened-array`, `error-field-object-storage-no-object-ref`, `origin-collection-simple`.

- [ ] **Step 1: Migrate the existing fixtures (rule-driven)**

Apply rules 1–4 to every `input/*.json` in the list. Example — `source-db-view-projection/input/meta.commerce.json` `ProgramSummary` source:

```jsonc
// before
{ "source.dbView": { "@name": "v_program_summary" } }
// after
{ "source.rdb": { "@kind": "view", "@table": "v_program_summary" } }
```

Do **not** hand-edit `expected.json` yet — regenerate it (Step 4).

- [ ] **Step 2: Fix `origin-collection-simple`**

In `origin-collection-simple/input/meta.ai.json`, change the `field.object` `"@isArray": true` → `"isArray": true`.

- [ ] **Step 3: Author the new fixtures**

`error-reserved-word-as-attr/` — input has a node with `"@isArray": true`; `expected-errors.json`:
```json
[ { "code": "ERR_RESERVED_ATTR" } ]
```

`error-source-no-primary/` — an `object.entity` with one `source.rdb` `@role: replica`; `expected-errors.json`:
```json
[ { "code": "ERR_SOURCE_NO_PRIMARY" } ]
```

`error-source-multiple-primary/` — an `object.entity` with two `source.rdb` (both default primary); `expected-errors.json`:
```json
[ { "code": "ERR_SOURCE_MULTIPLE_PRIMARY" } ]
```

`source-multi-source-roles/` — happy path: an `object.entity` with a primary `source.rdb` (`@table`) + a `source.rdb` (`@kind: view`, `@role: replica`, `@table`). `expected.json` regenerated.

`source-rdb-referential-actions/` — happy path: a `Program` + `Week` where `Week` has `relationship.composition` with `@onDelete: cascade`, `@onUpdate: cascade`, plus an `identity.reference` to `Program`. `expected.json` regenerated. (This is the loader-level round-trip proving the attrs serialize; the migrate DDL round-trip is Unit 2.)

`source-rdb-column/` — happy path: an entity with a `field.string` carrying `@column: "first_name"`. `expected.json` regenerated.

- [ ] **Step 4: Regenerate every `expected.json` from canonical output**

Use the TS loader's canonical serializer to produce expected output for each happy-path fixture (write a throwaway script or reuse a conformance helper that loads `input/` and prints `canonicalSerialize`). Verify against the body-key-order rule. Then run the conformance test:

Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts`
Expected: green for all migrated + new fixtures (TS now speaks v2).

- [ ] **Step 5: Update `ERROR-CODES.json` (shared)**

Add to `fixtures/conformance/ERROR-CODES.json` `codes`:
```json
"ERR_RESERVED_ATTR": "A reserved structural keyword (name/isArray/children/…) was written as an @-prefixed attribute in canonical JSON.",
"ERR_SOURCE_NO_PRIMARY": "An object declares source(s) but none has @role primary.",
"ERR_SOURCE_MULTIPLE_PRIMARY": "An object declares more than one @role primary source."
```

- [ ] **Step 6: Gate Java/Python/C# ledgers**

In `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`, set `fixtures` to every migrated + new source-v2 fixture (the full list from Step "Migrated fixtures" + the new fixtures from Step 3 that C# cannot yet load — i.e. all happy-path v2 fixtures + the 3 new error fixtures; the storage error fixtures already in C#'s registry stay).

In `server/python/tests/conformance/conformance-expected-failures.json`, **add** the same set to the existing list (it already gates `origin-collection-simple` + storage fixtures + template fixtures — keep those, add the rest).

> The happy-path migrated fixtures fail in C#/Python because those ports still load `dbTable`/`dbView` (or lack the v2 vocab). The 3 new error fixtures need their codes in the shared `ERROR-CODES.json` (Step 5) for C# lint to pass; Python doesn't registry-lint. Java has no ledger.

- [ ] **Step 7: Verify**

Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts` → green.
Run (if available): `cd server/csharp && dotnet test MetaObjects.Conformance.Tests` → green (v2 fixtures classified known-gap).
Run (if available): `cd server/python && python -m pytest tests/conformance` → green (v2 fixtures known-gap).

- [ ] **Step 8: Commit**

```bash
git add fixtures/conformance/ \
        server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json \
        server/python/tests/conformance/conformance-expected-failures.json
git commit -m "test(conformance): migrate corpus to source v2 + new fixtures; gate C#/Python ledgers"
```

---

### Task 8: Migrate remaining TS fixtures/inputs + update consumers to `@kind`/`@table`/`@column`

**Files (consumers — `src`):**
- `codegen-ts/src/projection/projection-detector.ts`, `extract-view-spec.ts`, `column-mapper.ts`, `relation-resolver.ts`
- `metadata/src/core/object/meta-object.ts` (`dbTable` getter), `naming.ts` (`resolveTableName`)
- `migrate-ts/src/expected-schema.ts` (skip-projection by `@kind`)
- `cli/src/lib/projection-migrations.ts` (no change if it only uses `isProjection`/`resolveTableName`)
- `runtime-ts/src/{query-builder,drivers/drizzle-driver,n2m-resolver}.ts` (use `resolveColumnName` — already updated; verify no direct `@dbColumn`)

**Files (test fixtures/inputs — `@dbColumn`→`@column`, `source.dbTable`→`source.rdb`+`@table`, `source.dbView`→`source.rdb`+`@kind:view`+`@table`):**
All non-conformance fixtures + in-test metadata under: `codegen-ts/test/**`, `codegen-ts-tanstack/test/**`, `cli/test/**`, `migrate-ts/test/**`, `metadata/test/**`, `runtime-ts/test/**` (the full file list is the grep result for `source.dbTable|source.dbView|@dbColumn` minus the worktrees; see the "blast radius" appendix). `sdk/src/agent-docs/body.ts` — update doc prose mentioning `@dbColumn`.

- [ ] **Step 1: Update the read-only / source-name consumers to `@kind`/`@table` (multi-source aware)**

`projection-detector.ts` — replace subtype checks with `@kind`-derived helpers. Add a `primarySource(entity)` helper (own-or-inherited source with effective role primary) and:

```ts
function hasReadOnlyKindSource(entity: MetaData): boolean {
  return entity.ownChildren().some(
    (c) => c instanceof MetaSource && c.isReadOnly());
}
function hasWritableKindSource(entity: MetaData): boolean {
  return entity.ownChildren().some(
    (c) => c instanceof MetaSource && c.isWritable());
}
export function isProjection(entity: MetaData): boolean {
  return hasReadOnlyKindSource(entity) && !hasWritableKindSource(entity);
}
export function isWriteThrough(entity: MetaData): boolean {
  return hasReadOnlyKindSource(entity) && hasWritableKindSource(entity);
}
```

`extract-view-spec.ts` — `viewName` reads the read-only source's `@table` (`MetaSource.tableName`) instead of `SOURCE_DB_VIEW_ATTR_NAME`; `sourceColumnNameFor` uses `resolveColumnName` (already prefers `@column`).

`meta-object.ts` `dbTable` getter — find the **primary writable** `source.rdb` and read `tableName` (`@table`). `naming.ts` `resolveTableName` — same; fall back to `tableNameFromEntity`.

`migrate-ts/src/expected-schema.ts` — replace the `subType === SOURCE_SUBTYPE_DB_VIEW` skip (line ~66) with `instanceof MetaSource && c.isReadOnly()` (skip read-only sources from table-diff).

- [ ] **Step 2: Bulk-migrate the test fixtures/inputs (rule-driven)**

Apply the Task-7 transformation rules 1–3 to every listed test file. These are JSON literals embedded in `.ts` tests and standalone `.json` fixtures. Be mechanical and exhaustive; after each package, run that package's tests.

- [ ] **Step 3: Regenerate golden snapshots**

Run: `cd server/typescript/packages/codegen-ts && UPDATE_GOLDEN=1 bun test test/golden/golden-output.test.ts`
Then inspect the snapshot diff: it should reflect **only** the v2 input rename (table/column names unchanged in output — `@name`→`@table` and `@dbColumn`→`@column` resolve to the same physical strings). If any *output* table/column name changed unexpectedly, stop and investigate.

- [ ] **Step 4: Run each consumer package's tests**

```
cd server/typescript/packages/metadata && bun test
cd server/typescript/packages/codegen-ts && bun test
cd server/typescript/packages/codegen-ts-react && bun test
cd server/typescript/packages/codegen-ts-tanstack && bun test
cd server/typescript/packages/runtime-ts && bun test
cd server/typescript/packages/migrate-ts && bun test
cd server/typescript/packages/cli && bun test
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(ts): consumers read @kind/@table/@column; migrate all TS test fixtures to source v2"
```

---

### Task 9: Drop the v1 vocabulary; full green + typecheck

**Files:**
- `metadata/src/persistence/source/source-constants.ts` (remove `SOURCE_SUBTYPE_DB_TABLE`/`DB_VIEW`, `SOURCE_DB_TABLE_ATTR_NAME`/`SOURCE_DB_VIEW_ATTR_NAME`/`SOURCE_ATTR_NAME`)
- `metadata/src/persistence/source/source-schema.ts` / `db-schema.ts` (remove `sourceNameSchema`)
- `metadata/src/persistence/db/db-provider.ts` (remove the dbTable/dbView extends; remove `dbColumnSchema` if `@dbColumn` fully dropped)
- `metadata/src/persistence/db/db-constants.ts` (remove `FIELD_ATTR_DB_COLUMN`)
- `metadata/src/persistence/source/meta-source.ts` (remove `sourceName` getter / `SOURCE_ATTR_NAME` use)
- `metadata/src/core/object/meta-object.ts`, `naming.ts`, `meta-field.ts` (remove `@dbColumn` fallbacks)
- `core-types.ts` (`SOURCE_SUBTYPES` = `[SUBTYPE_BASE, SOURCE_SUBTYPE_RDB]`)
- Any consumer still importing the dropped constants.

> **Decision:** drop `@dbColumn` entirely (no back-compat hacks). `resolveColumnName`/`meta-field` read only `@column`. Confirm no remaining `@dbColumn` references first: `grep -rn "FIELD_ATTR_DB_COLUMN\|dbColumn\|SOURCE_SUBTYPE_DB\|SOURCE_DB_TABLE_ATTR\|SOURCE_DB_VIEW_ATTR\|SOURCE_ATTR_NAME" server/typescript/packages/*/src` (exclude worktrees) → must be empty before removing.

- [ ] **Step 1: Remove the dropped fallbacks/constants**

Strip the `@dbColumn` fallback from `resolveColumnName` and `meta-field`; delete `dbColumnSchema` + its `db-provider` extend; delete `sourceNameSchema` + the dbTable/dbView extends; delete the v1 subtype + name constants; set `SOURCE_SUBTYPES = [SUBTYPE_BASE, SOURCE_SUBTYPE_RDB]`.

- [ ] **Step 2: Fix compile fallout**

Run: `cd server/typescript && bun run --filter '*' typecheck`
Fix every reference to a now-removed symbol (these are the remaining import sites). Iterate until typecheck is clean.

- [ ] **Step 3: Full server suite green**

Run: `cd server/typescript && bun test`
Expected: 2332+ pass, 0 fail. (New tests added net-positive.)

- [ ] **Step 4: Workspace typecheck + build**

Run: `cd server/typescript && bun run --filter '*' typecheck && bun run --filter '*' build`
Expected: clean.

- [ ] **Step 5: Grep guard — no v1 vocabulary remains in TS src**

Run: `grep -rn "dbTable\|dbView\|@dbColumn\|FIELD_ATTR_DB_COLUMN\|SOURCE_ATTR_NAME" server/typescript/packages/*/src --include=*.ts`
Expected: no matches (besides comments referencing the migration, if any — prefer none).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(metadata)!: drop source.dbTable/dbView + @dbColumn (source v2 cutover complete)"
```

---

### Unit 1 close-out: review + simplify + merge + push

- [ ] Run `superpowers:requesting-code-review` (code-reviewer) on the Unit-1 diff (`git diff main...HEAD`). Address findings.
- [ ] Run the `code-simplifier` agent on the changed code. Apply safe simplifications; re-run `cd server/typescript && bun test`.
- [ ] Re-verify: `cd server/typescript && bun test` green + `bun run --filter '*' typecheck` clean.
- [ ] Merge forward to `main` (fast-forward `main` to the worktree tip; never rebase/reset `main`) and push:
```bash
git -C <main-checkout> fetch && git -C <main-checkout> merge --ff-only worktree-source-v2-stage1
git -C <main-checkout> push origin main
```
(If `main` advanced and FF is impossible, merge `main` into the worktree branch first, re-test, then FF `main`.)

---

# UNIT 2 — Referential actions threaded into migrate-ts (1d)

**Additive unit.** Threads the relationship `@onDelete`/`@onUpdate` (added to the loader in Unit 1 Task 6) into `migrate-ts`'s expected-schema `FkDescriptor`, deriving the default from the relationship subtype and overriding with the explicit attr. Emit/introspect/diff already handle the actions. At completion: `cd server/typescript/packages/migrate-ts && bun test` green + a round-trip fixture. Then `review + simplify`, merge, push.

---

### Task 10: Derive-action helper (subtype default + explicit override + no-action omission)

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/referential-actions.ts`
- Test: `server/typescript/packages/migrate-ts/test/unit/referential-actions.test.ts` (new)

**Contract:** given a `MetaReferenceIdentity` and its owning entity, find the correlated relationship (a `MetaRelationship` whose `objectRef` resolves to the reference's `targetEntity`); resolve `onDelete`/`onUpdate`:
- `onDelete` = explicit `relationship.onDelete` ?? `ON_DELETE_DEFAULT_BY_SUBTYPE[relationship.subType]`.
- `onUpdate` = explicit `relationship.onUpdate` ?? `ON_UPDATE_DEFAULT` (`cascade`).
- If **no** correlated relationship is found → both undefined (preserve today's no-clause behavior).
- If a resolved value is `"no-action"` → return it as **undefined** (introspection omits `no-action`, so the expected side must too, keeping round-trips clean).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { resolveReferentialActions } from "../../src/referential-actions.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";

function weekWith(rel: Record<string, unknown>) {
  const res = new MetaDataLoader().loadFromObjects([{ name: "m.json", data: {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Program", children: [
        { "field.long": { name: "id" } }, { "identity.primary": { "@fields": "id" } } ] } },
      { "object.entity": { name: "Week", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "programId" } },
        rel,
        { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program" } },
        { "identity.primary": { "@fields": "id" } },
      ] } },
    ] },
  } }]);
  const week = res.root.objects().find((o) => o.name === "Week")!;
  const ref = week.referenceIdentities()[0];
  return { week, ref };
}

describe("resolveReferentialActions", () => {
  test("composition → cascade / cascade(default)", () => {
    const { week, ref } = weekWith({ "relationship.composition": { name: "program", "@objectRef": "Program", "@cardinality": "one" } });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "cascade", onUpdate: "cascade" });
  });
  test("association → restrict / cascade(default)", () => {
    const { week, ref } = weekWith({ "relationship.association": { name: "program", "@objectRef": "Program", "@cardinality": "one" } });
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "restrict", onUpdate: "cascade" });
  });
  test("explicit override wins", () => {
    const { week, ref } = weekWith({ "relationship.composition": { name: "program", "@objectRef": "Program", "@onDelete": "set-null", "@onUpdate": "no-action" } });
    // onUpdate no-action → omitted (undefined)
    expect(resolveReferentialActions(week, ref)).toEqual({ onDelete: "set-null", onUpdate: undefined });
  });
  test("no correlated relationship → both undefined", () => {
    // reference with no sibling relationship
    const res = new MetaDataLoader().loadFromObjects([{ name: "m.json", data: {
      "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "Program", children: [ { "field.long": { name: "id" } }, { "identity.primary": { "@fields": "id" } } ] } },
        { "object.entity": { name: "Week", children: [
          { "field.long": { name: "id" } }, { "field.long": { name: "programId" } },
          { "identity.reference": { name: "ref_program", "@fields": ["programId"], "@references": "Program" } },
          { "identity.primary": { "@fields": "id" } } ] } },
      ] },
    } }]);
    const week = res.root.objects().find((o) => o.name === "Week")!;
    expect(resolveReferentialActions(week, week.referenceIdentities()[0])).toEqual({ onDelete: undefined, onUpdate: undefined });
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`resolveReferentialActions` does not exist).

- [ ] **Step 3: Implement `referential-actions.ts`**

```ts
import type { MetaObject, MetaReferenceIdentity } from "@metaobjectsdev/metadata";
import {
  ON_DELETE_DEFAULT_BY_SUBTYPE, ON_UPDATE_DEFAULT,
} from "@metaobjectsdev/metadata"; // re-export the constants from the metadata barrel
import type { FkAction } from "./types.js";

function normalize(a: string | undefined): FkAction | undefined {
  if (a === undefined || a === "no-action") return undefined; // introspection omits no-action
  return a as FkAction;
}

export function resolveReferentialActions(
  entity: MetaObject,
  ref: MetaReferenceIdentity,
): { onDelete: FkAction | undefined; onUpdate: FkAction | undefined } {
  const target = ref.targetEntity;
  const rel = entity.relationships().find((r) => r.objectRef === target);
  if (rel === undefined) return { onDelete: undefined, onUpdate: undefined };
  const onDelete = rel.onDelete ?? ON_DELETE_DEFAULT_BY_SUBTYPE[rel.subType];
  const onUpdate = rel.onUpdate ?? ON_UPDATE_DEFAULT;
  return { onDelete: normalize(onDelete), onUpdate: normalize(onUpdate) };
}
```

> Ensure `ON_DELETE_DEFAULT_BY_SUBTYPE`, `ON_UPDATE_DEFAULT`, `MetaObject`, `MetaReferenceIdentity`, `MetaRelationship.onDelete/onUpdate/objectRef/subType`, and `MetaObject.relationships()` are all exported from the `@metaobjectsdev/metadata` barrel (add re-exports if missing). Correlation is by target-entity name; if multiple relationships match, take the first (note the limitation in a comment).

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/referential-actions.ts \
        server/typescript/packages/migrate-ts/test/unit/referential-actions.test.ts \
        server/typescript/packages/metadata/src/index.ts
git commit -m "feat(migrate-ts): resolveReferentialActions (subtype default + explicit override)"
```

---

### Task 11: Thread actions into `buildForeignKeys`; update expectations; round-trip fixture

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts`
- Modify: `server/typescript/packages/migrate-ts/test/unit/expected-schema.test.ts`
- Create: `server/typescript/packages/migrate-ts/test/fixtures/referential-actions.json` (if a dedicated fixture helps)
- Modify any existing migrate-ts test asserting FKs without actions (e.g. `test/unit/expected-schema.test.ts` "many-to-one relationship → FK").

- [ ] **Step 1: Write/adjust the failing test**

In `expected-schema.test.ts`, update the existing `two-entities-fk` FK expectation. `Week`'s relationship is `association` → default `onDelete: "restrict"`, `onUpdate: "cascade"`:

```ts
test("many-to-one association → FK with restrict/cascade", () => {
  const weeks = snapshot.tables.find((t) => t.name === "weeks");
  expect(weeks?.foreignKeys).toEqual([
    { name: "weeks_program_id_fk", columns: ["program_id"], refTable: "programs",
      refColumns: ["id"], onDelete: "restrict", onUpdate: "cascade" },
  ]);
});
```

Add a composition case (new small inline fixture or extend the fixture) asserting `onDelete: "cascade"`.

- [ ] **Step 2: Run test → FAIL** (current FK has no `onDelete`/`onUpdate`).

- [ ] **Step 3: Thread the actions in `buildForeignKeys`**

In `expected-schema.ts`, in the `for (const refChild of entity.referenceIdentities())` loop, compute actions and spread only the defined ones (so a `no-action`/absent value omits the field — matching introspection):

```ts
import { resolveReferentialActions } from "./referential-actions.js";
// ...
const { onDelete, onUpdate } = resolveReferentialActions(entity, refChild);
const fk: FkDescriptor = { name: `${tableName}_${fkCols[0]}_fk`, columns: fkCols, refTable, refColumns };
if (onDelete !== undefined) fk.onDelete = onDelete;
if (onUpdate !== undefined) fk.onUpdate = onUpdate;
fks.push(fk);
```

- [ ] **Step 4: Run migrate-ts unit tests → PASS.** Update any other FK assertions that now carry actions (search `foreignKeys` / `_fk"` in migrate-ts tests).

Run: `cd server/typescript/packages/migrate-ts && bun test`

- [ ] **Step 5: Round-trip verification (if a live-DB integration harness exists)**

If `test/integration/*roundtrip*` runs against a real Postgres/SQLite, confirm create-from-empty → emit → apply → re-diff yields **no changes** with the new actions (the emitter renders `ON DELETE RESTRICT ON UPDATE CASCADE`, introspection reads them back, diff is clean). If integration DBs are unavailable in this environment, rely on the unit round-trip: `emit(buildExpectedSchema(...))` contains the expected clause, and `pgRuleToAction`/`sqliteRuleToAction` already map them back.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/migrate-ts/
git commit -m "feat(migrate-ts): thread relationship @onDelete/@onUpdate into FK descriptors"
```

---

### Task 12: `set-null` requires a nullable relation — guard + test

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts` (or the `verify` path, matching where other FK-shape diagnostics live)
- Test: `server/typescript/packages/migrate-ts/test/unit/referential-actions-nullable.test.ts` (new)

> The decided default makes aggregation→`set-null`, and the spec says `set-null` requires the FK column(s) optional. Emit a clear diagnostic when `onDelete: "set-null"` but a referencing FK field is `@required` (NOT NULL).

- [ ] **Step 1: Write the failing test**

A `Week` with `programId @required: true` and a `relationship.aggregation` to `Program` (→ default `set-null`) should surface a diagnostic (decide the exact surface — a thrown error, a `Change` with a blocked status, or a `verify` finding — by reading how migrate-ts currently reports unsafe operations; match it). Assert that surface.

```ts
// Skeleton — adapt the assertion to migrate-ts's diagnostic surface:
test("set-null on a required FK field is flagged", () => {
  // load Week.programId @required + relationship.aggregation → Program
  // expect: buildExpectedSchema (or verify) reports a set-null-requires-nullable diagnostic
});
```

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement the guard**

When resolving the FK action, if `onDelete === "set-null"` and any FK column maps to a `@required` field, emit the diagnostic via migrate-ts's existing reporting surface. Keep it minimal and located.

- [ ] **Step 4: Run test → PASS.** `cd server/typescript/packages/migrate-ts && bun test` green.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/
git commit -m "feat(migrate-ts): flag set-null referential action on a NOT NULL FK column"
```

---

### Unit 2 close-out: review + simplify + merge + push

- [ ] `superpowers:requesting-code-review` on the Unit-2 diff. Address findings.
- [ ] `code-simplifier` on the changed code; re-run `cd server/typescript/packages/migrate-ts && bun test`.
- [ ] Re-verify: `cd server/typescript && bun test` green + `bun run --filter '*' typecheck` clean.
- [ ] Fast-forward `main` to the worktree tip; push origin main.

---

## Self-review (run before executing)

**Spec coverage:**
- ADR-0007 source v2 (rdb subtype, `@table`/`@kind`/`@role`/`@schema`, multi-source, read-only from `@kind`): Tasks 1–2, 5, 7–9. ✓
- `@dbColumn`→`@column`: Tasks 1, 3, 7–9. ✓
- ADR-0006 `ERR_RESERVED_ATTR` (canonical JSON corollary; YAML itself is Stage 4): Tasks 1, 4, 7. ✓
- Persistence spec referential actions (`@onDelete`/`@onUpdate`, defaults-from-subtype, `FkAction` set): Tasks 1, 6 (loader schema), 10–12 (migrate threading). ✓
- One-primary multi-source validation: Task 5. ✓
- Conformance corpus migration + new fixtures + gating: Task 7. ✓
- Consumers route by `@kind`/`@table`/`@column`/`@role`: Task 8. ✓
- C# held / Java no-ledger / Python gated: Task 7 Step 6. ✓

**Out of scope (intentionally):** YAML sigil-free authoring (Stage 4), enum datatype (Stage 5), `@indexed`/`@softDelete`/`@version`/`@enforce`/`@fetch` normalization (broader persistence track), the ten non-rdb paradigms.

**Type consistency:** `MetaSource.{tableName, effectiveKind, role, isReadOnly, isWritable}`; `FIELD_ATTR_COLUMN`; `REFERENTIAL_ACTIONS`/`ON_DELETE_DEFAULT_BY_SUBTYPE`/`ON_UPDATE_DEFAULT`; `resolveReferentialActions(entity, ref)` returning `{onDelete, onUpdate}` — used consistently across Tasks 6, 10, 11.

**Known confirm-in-situ points (not placeholders — verify the exact symbol, then proceed):** loader entry point + result-error shape (`loadFromObjects` vs `loadFromDirectory`); the `ATTR_SUBTYPE_STRING` import module; the validation-pass error-object constructor; `root.objects()` availability at the validation layer; the metadata barrel re-exports for migrate-ts; migrate-ts's diagnostic surface for the Task-12 guard.

## Appendix — blast-radius file list (Task 8 mechanical migration)

`source.dbTable`/`source.dbView` in TS tests/src (non-worktree): `cli/test/unit/projection-migrations.test.ts`; `codegen-ts/src/relation-resolver.ts`; `codegen-ts-tanstack/test/projection-hooks.test.ts`; `codegen-ts/test/projection/{entity-file,extract-view-spec,projection-detector,routes-file}.test.ts`; `codegen-ts/test/templates/{api-prefix,extends-base-entity,projection-decl}.test.ts`; `metadata/src/persistence/db/{db-provider,db-schema}.ts`; `metadata/test/{attr-schema,db/db-provider,loader-origin-validation,meta/meta-misc,naming,storage-validation}.test.ts`; `migrate-ts/src/expected-schema.ts`; `migrate-ts/test/{emit-postgres-schema-namespacing,emit-sqlite-schema-rejected,expected-schema-field-object-storage,expected-schema-schema-aware,unit/expected-schema}.test.ts`.

`@dbColumn` in TS tests/src (non-worktree, additional): `cli/test/fixtures/{multi-package-meta/metaobjects/{common,domain}.json, trainer-website-meta/metaobjects/myapp.json}`; `cli/test/integration/{migrate-ambiguous,migrate-sqlite}.test.ts`; `codegen-ts/src/{column-mapper,metaobjects-config,projection/extract-view-spec}.ts`; `codegen-ts/test/{column-mapper,templates/extends-base-entity}.test.ts`; `metadata/src/{core/field/meta-field,naming,persistence/db/{db-constants,db-provider,db-schema},registry}.ts`; `metadata/test/{attr-schema,db/db-provider,meta/meta-field,parser-equivalence,parser-json,provider,yaml-desugar}.test.ts`; `runtime-ts/src/{drivers/drizzle-driver,n2m-resolver}.ts`; `runtime-ts/test/query-builder.test.ts`; `sdk/src/agent-docs/body.ts`.

`@isArray` (TS-loaded): `fixtures/conformance/origin-collection-simple/` only (Python/Java `@isArray` usages are out of scope for Stage 1).
