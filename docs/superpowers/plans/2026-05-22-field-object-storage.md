# `field.object` + `@storage` Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify "owned types" (flatten into parent columns, EF `OwnsOne` pattern) and "structured JSONB" (single jsonb column, typed shape) under one metadata concept: a `field.object` that nests an `object.value` via `@objectRef`, with an explicit `@storage` hint telling codegen and `buildExpectedSchema` which storage strategy to use.

**Architecture:** Add a new `@storage` attribute on field-level nodes with values `"flattened"`, `"jsonb"`, or `"subdocument"`. The metadata loader validates the attr value; `buildExpectedSchema` walks `@storage "flattened"` field-objects to emit multiple prefixed columns from the nested `object.value`. JSONB and subdocument modes (and the no-`@storage` default) keep the existing single-column behavior. The metamodel is dialect-neutral; codegen for each dialect interprets `@storage` against its target.

**Tech Stack:** TypeScript 5.x (Bun-first), Vitest-style tests via `bun:test`, named constants for all metamodel strings (per `CLAUDE.md`), `exactOptionalPropertyTypes: true`.

---

## Background — what exists today

- `object.value` is a registered object subtype. Round-trips through the canonical serializer.
- `field.object` is a registered field subtype. The `@objectRef` attr already exists (`FIELD_ATTR_OBJECT_REF`) and is declared in `commonFieldAttrs`.
- `buildExpectedSchema` already maps `FIELD_SUBTYPE_OBJECT → SqlType { kind: "json" }` (single column).
- `emit/postgres.ts` already maps `kind: "json" → JSONB` DDL.
- **Missing:** the `@storage` attr itself; the flattening logic that walks `@objectRef` to emit multiple columns when `@storage "flattened"`.

After this plan, `@storage "jsonb"` (or `@storage` absent) preserves today's behavior — single jsonb column. `@storage "flattened"` is the new flag that triggers multi-column emission. `@storage "subdocument"` is recognized but doesn't generate Postgres columns (it's a hint for document-store codegen targets — Mongo/CouchDB/etc.).

## File Structure

**Modify:**
- `server/typescript/packages/metadata/src/constants.ts` — add `FIELD_OBJECT_ATTR_STORAGE` constant + storage value enum
- `server/typescript/packages/metadata/src/core-attr-schemas.ts` — add `@storage` to `commonFieldAttrs` with enum value validation
- `server/typescript/packages/migrate-ts/src/expected-schema.ts` — handle `@storage "flattened"`: walk `@objectRef` and emit prefixed columns; `@storage "jsonb"` and absent → existing single-column behavior
- `CLAUDE.md` — document `@storage` in the cross-language vocabulary list

**Create:**
- `fixtures/conformance/field-object-storage-flattened/{input,expected}.json` — flattened storage round-trip
- `fixtures/conformance/field-object-storage-flattened-nullable/{input,expected}.json` — nullable flattened owned-type block
- `fixtures/conformance/field-object-storage-jsonb-single/{input,expected}.json` — JSONB with single nested value
- `fixtures/conformance/field-object-storage-jsonb-array/{input,expected}.json` — JSONB array of values via `isArray true`
- `server/typescript/packages/migrate-ts/test/expected-schema-field-object-storage.test.ts` — schema-snapshot tests against the four storage shapes

**Do not touch in this plan:**
- `introspect/postgres.ts` — reverse-engineering a JSONB structure from a live DB is impossible without external schema knowledge. The introspect continues to emit a single `kind: "json"` column for any jsonb column, regardless of structure. The metadata side declares the structure; the diff layer reconciles by column name + type.
- C# loader code — `@storage` is an opaque attr that round-trips via existing passthrough. A Task at the end verifies the conformance fixtures pass on the C# runner with zero C# code changes.
- Codegen — the codegen-ts / codegen-ts-tanstack packages will eventually honor `@storage` when emitting Drizzle schemas / EF entity partials, but that lives in separate codegen plans.

---

## Task 1: Constants for `@storage`

**Files:**
- Modify: `server/typescript/packages/metadata/src/constants.ts`

- [ ] **Step 1: Add the storage constants near the existing FIELD_ATTR_OBJECT_REF block**

Locate the existing field-attrs section (search for `FIELD_ATTR_OBJECT_REF`). Just below `FIELD_ATTR_OBJECT_REF` (around line 372), append:

```typescript
/** Storage strategy for an object-typed field. Meaningful only when @objectRef is set.
 *  Cross-language metamodel attr — every port must accept and round-trip it. */
export const FIELD_ATTR_STORAGE = "storage";

/** @storage "flattened" — nested object's columns expand into the parent table,
 *  each prefixed by the parent field's DB name (EF OwnsOne pattern). Requires
 *  the parent field.object to have isArray=false; arrays-of-values must use jsonb. */
export const STORAGE_FLATTENED = "flattened";

/** @storage "jsonb" — the nested value (or array of values when isArray=true) lives
 *  in a single jsonb column. The structure is typed by metadata; storage is opaque. */
export const STORAGE_JSONB = "jsonb";

/** @storage "subdocument" — document-store-native nested document. No Postgres
 *  column is emitted for this; codegen targets like Mongo render it inline. */
export const STORAGE_SUBDOCUMENT = "subdocument";

export const STORAGE_VALUES = [
  STORAGE_FLATTENED,
  STORAGE_JSONB,
  STORAGE_SUBDOCUMENT,
] as const;
export type StorageValue = (typeof STORAGE_VALUES)[number];
```

- [ ] **Step 2: Verify the package compiles**

Run from `server/typescript`:

```bash
bun run --filter '@metaobjectsdev/metadata' typecheck
```

Expected: `@metaobjectsdev/metadata typecheck: Exited with code 0`.

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/metadata/src/constants.ts
git commit -m "feat(metadata): add FIELD_OBJECT_ATTR_STORAGE + STORAGE_* value constants"
```

---

## Task 2: Wire `@storage` into `commonFieldAttrs` with enum validation

**Files:**
- Modify: `server/typescript/packages/metadata/src/core-attr-schemas.ts`
- Test: existing schema-validation tests cover this — verify via the full test suite

- [ ] **Step 1: Update imports + add the `@storage` attr-schema entry**

Open `server/typescript/packages/metadata/src/core-attr-schemas.ts`. Find the imports block at the top. Add `FIELD_ATTR_STORAGE` and `STORAGE_VALUES` to the existing `from "./constants.js"` import:

```typescript
import {
  // ... existing imports
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  STORAGE_VALUES,
  // ... existing imports
} from "./constants.js";
```

Find the `commonFieldAttrs` definition (search for `commonFieldAttrs: AttrSchema[] = [`). Append a new entry directly after the `FIELD_ATTR_OBJECT_REF` entry:

```typescript
  {
    name: FIELD_ATTR_STORAGE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...STORAGE_VALUES],
    description:
      "Storage strategy for an object-typed field (set with @objectRef). " +
      "\"flattened\" expands the nested value into prefixed columns on the parent " +
      "table. \"jsonb\" stores the structured value in a single jsonb column " +
      "(supports isArray=true for arrays of values). \"subdocument\" is a hint for " +
      "document-store codegen targets and emits no Postgres column.",
  },
```

- [ ] **Step 2: Run the metadata test suite**

```bash
cd server/typescript/packages/metadata && bun test
```

Expected: all existing tests still green. (No regression — we only added an optional attr declaration.)

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/metadata/src/core-attr-schemas.ts
git commit -m "feat(metadata): declare @storage attr-schema for object-typed fields"
```

---

## Task 3: Validate `@storage` semantic constraints

**Files:**
- Modify: `server/typescript/packages/metadata/src/core-attr-schemas.ts` (or wherever node-level validation lives — verify by reading the file first)
- Test: `server/typescript/packages/metadata/test/storage-validation.test.ts`

- [ ] **Step 1: Locate the post-load validation hook**

Open `server/typescript/packages/metadata/src/core-attr-schemas.ts`. The attribute-schema system enforces `allowedValues` automatically (you set that in Task 2). What it does NOT enforce: the cross-attribute rules. Specifically:
- `@storage` requires `@objectRef` to also be set (storage is meaningless without a referenced object).
- `@storage "flattened"` requires `isArray` to be absent or `false` (cannot flatten an unbounded array into a fixed column set).

Read `core-attr-schemas.ts` from the top to find how cross-attribute validation is expressed today. Some metamodels use a post-load validator pass; others encode rules in the schema declarations. Match whatever pattern exists. If there is no pattern, add a small post-load hook in this file:

```typescript
/**
 * Cross-attribute validation: enforce semantic rules that the per-attr schema
 * cannot capture.
 *
 *   - @storage requires @objectRef on the same field.
 *   - @storage "flattened" requires isArray=false (cannot flatten a variable-length array).
 *
 * Called by the loader's validation pass.
 */
export function validateFieldObjectStorage(field: MetaData): ValidationError[] {
  const storage = field.ownAttr(FIELD_ATTR_STORAGE);
  if (storage === undefined || storage === null) return [];
  const objectRef = field.ownAttr(FIELD_ATTR_OBJECT_REF);
  const errors: ValidationError[] = [];
  if (typeof objectRef !== "string" || objectRef.length === 0) {
    errors.push({
      code: "ERR_STORAGE_WITHOUT_OBJECT_REF",
      message: `field "${field.name}" sets @storage but has no @objectRef`,
    });
  }
  if (storage === STORAGE_FLATTENED && field.isArray === true) {
    errors.push({
      code: "ERR_STORAGE_FLATTENED_ARRAY",
      message: `field "${field.name}" sets @storage "flattened" with isArray=true; flattened storage requires a single nested value`,
    });
  }
  return errors;
}
```

**IMPORTANT:** before writing this verbatim, read `core-attr-schemas.ts` to confirm the existing patterns for `ValidationError`, the validation invocation point, and how other cross-attribute rules (if any) are expressed. If the pattern differs (e.g., validators are invoked from `parser.ts` or `loader.ts`), put the function where it actually gets called.

- [ ] **Step 2: Register the two new error codes**

Open `fixtures/conformance/ERROR-CODES.json`. Add:

```json
"ERR_STORAGE_WITHOUT_OBJECT_REF": "@storage was set on a field that has no @objectRef.",
"ERR_STORAGE_FLATTENED_ARRAY": "@storage \"flattened\" cannot be combined with isArray=true."
```

(Insert alphabetically among existing codes; keep the JSON valid.)

- [ ] **Step 3: Write the failing tests**

Create `server/typescript/packages/metadata/test/storage-validation.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";

async function load(doc: unknown): Promise<{ ok: boolean; errors: string[] }> {
  try {
    await new MetaDataLoader().load([new InMemorySource(JSON.stringify(doc))]);
    return { ok: true, errors: [] };
  } catch (e) {
    // ValidationError aggregates may surface as a single thrown error or via a result;
    // adapt to the actual loader contract. If MetaDataLoader returns errors instead
    // of throwing, the catch branch is unreached — see the loader's signature.
    const err = e as { errors?: Array<{ code?: string }>; message?: string };
    const codes = err.errors?.map((x) => x.code ?? "").filter(Boolean) ?? [];
    if (codes.length > 0) return { ok: false, errors: codes };
    return { ok: false, errors: [err.message ?? String(e)] };
  }
}

describe("@storage cross-attribute validation", () => {
  test("@storage without @objectRef is rejected with ERR_STORAGE_WITHOUT_OBJECT_REF", async () => {
    const result = await load({
      "metadata.root": {
        package: "test",
        children: [
          { "object.entity": { name: "Order", children: [
            { "source.dbTable": { "@name": "orders" } },
            { "field.object": { name: "addr", "@storage": "flattened" } },
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ERR_STORAGE_WITHOUT_OBJECT_REF");
  });

  test('@storage "flattened" + isArray true is rejected with ERR_STORAGE_FLATTENED_ARRAY', async () => {
    const result = await load({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Address", children: [
            { "field.string": { name: "street" } },
          ]}},
          { "object.entity": { name: "Order", children: [
            { "source.dbTable": { "@name": "orders" } },
            { "field.object": { name: "addrs", isArray: true, "@objectRef": "Address", "@storage": "flattened" } },
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ERR_STORAGE_FLATTENED_ARRAY");
  });

  test('valid @storage "flattened" with @objectRef + isArray false passes', async () => {
    const result = await load({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Address", children: [
            { "field.string": { name: "street" } },
          ]}},
          { "object.entity": { name: "Order", children: [
            { "source.dbTable": { "@name": "orders" } },
            { "field.object": { name: "addr", "@objectRef": "Address", "@storage": "flattened" } },
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  test('valid @storage "jsonb" with @objectRef + isArray true passes', async () => {
    const result = await load({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "ContactInfo", children: [
            { "field.string": { name: "email" } },
          ]}},
          { "object.entity": { name: "Patient", children: [
            { "source.dbTable": { "@name": "patients" } },
            { "field.object": { name: "contactInfos", isArray: true, "@objectRef": "ContactInfo", "@storage": "jsonb" } },
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd server/typescript/packages/metadata && bun test storage-validation.test.ts
```

Expected: at least the two "should be rejected" tests FAIL — currently the loader accepts these malformed inputs without complaint.

- [ ] **Step 5: Wire the validator into the loader's validation pass**

Find where existing per-field validation gets dispatched (search for a function that walks fields and calls validation hooks — likely in `core-attr-schemas.ts` itself or `parser.ts` / `loader.ts`). Add a call to `validateFieldObjectStorage` for every `field.object` node.

The exact code depends on the existing pattern. If validation is collected into an array of error codes and surfaced via the loader's return / throw, add this validator to that pipeline. If validation happens immediately during parse, hook it there.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd server/typescript/packages/metadata && bun test storage-validation.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 7: Run the full metadata suite for no regression**

```bash
cd server/typescript/packages/metadata && bun test
```

Expected: all previously-passing tests still green.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/metadata/src/core-attr-schemas.ts server/typescript/packages/metadata/test/storage-validation.test.ts fixtures/conformance/ERROR-CODES.json
git commit -m "feat(metadata): validate @storage cross-attribute constraints (requires @objectRef, rejects flattened+isArray)"
```

---

## Task 4: `buildExpectedSchema` flattens `@storage "flattened"` into prefixed columns

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts`
- Test: `server/typescript/packages/migrate-ts/test/expected-schema-field-object-storage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/typescript/packages/migrate-ts/test/expected-schema-field-object-storage.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

async function loadDoc(doc: unknown) {
  const result = await new MetaDataLoader().load([
    new InMemorySource(JSON.stringify(doc)),
  ]);
  return result.root;
}

describe("buildExpectedSchema — field.object @storage", () => {
  test("@storage \"flattened\" emits one column per nested field, prefixed by parent field name", async () => {
    const root = await loadDoc({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Address", children: [
            { "field.string": { name: "street", "@required": true } },
            { "field.string": { name: "city", "@required": true } },
            { "field.string": { name: "postalCode" } },
          ]}},
          { "object.entity": { name: "Customer", children: [
            { "source.dbTable": { "@name": "customers" } },
            { "field.long":   { name: "id" } },
            { "field.object": { name: "shippingAddress", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const customers = snap.tables.find((t) => t.name === "customers");
    const cols = customers?.columns.map((c) => c.name) ?? [];
    expect(cols).toContain("shipping_address_street");
    expect(cols).toContain("shipping_address_city");
    expect(cols).toContain("shipping_address_postal_code");
    // The parent field.object itself must NOT also appear as a jsonb column.
    expect(cols).not.toContain("shipping_address");
  });

  test("@storage \"flattened\" preserves nested @required per column", async () => {
    const root = await loadDoc({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Address", children: [
            { "field.string": { name: "street", "@required": true } },
            { "field.string": { name: "city",   "@required": true } },
            { "field.string": { name: "postalCode" } },
          ]}},
          { "object.entity": { name: "Customer", children: [
            { "source.dbTable": { "@name": "customers" } },
            { "field.long":   { name: "id" } },
            { "field.object": { name: "shippingAddress", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const customers = snap.tables.find((t) => t.name === "customers")!;
    const street = customers.columns.find((c) => c.name === "shipping_address_street");
    const postal = customers.columns.find((c) => c.name === "shipping_address_postal_code");
    expect(street?.nullable).toBe(false);
    expect(postal?.nullable).toBe(true);
  });

  test("@storage \"jsonb\" emits a single jsonb (kind: json) column", async () => {
    const root = await loadDoc({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "ContactInfo", children: [
            { "field.string": { name: "email" } },
          ]}},
          { "object.entity": { name: "Patient", children: [
            { "source.dbTable": { "@name": "patients" } },
            { "field.long":   { name: "id" } },
            { "field.object": { name: "contactInfos", isArray: true, "@objectRef": "ContactInfo", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const patients = snap.tables.find((t) => t.name === "patients")!;
    const contactInfos = patients.columns.find((c) => c.name === "contact_infos");
    expect(contactInfos?.sqlType.kind).toBe("json");
  });

  test("@storage absent on field.object defaults to jsonb behavior (back-compat)", async () => {
    const root = await loadDoc({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Blob", children: [
            { "field.string": { name: "data" } },
          ]}},
          { "object.entity": { name: "Item", children: [
            { "source.dbTable": { "@name": "items" } },
            { "field.long":   { name: "id" } },
            { "field.object": { name: "payload", "@objectRef": "Blob" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const items = snap.tables.find((t) => t.name === "items")!;
    const payload = items.columns.find((c) => c.name === "payload");
    expect(payload?.sqlType.kind).toBe("json");
  });
});
```

- [ ] **Step 2: Run tests to verify the flattened ones fail**

```bash
cd server/typescript/packages/migrate-ts && bun test expected-schema-field-object-storage.test.ts
```

Expected: the two `@storage "flattened"` tests FAIL (no prefixed columns are produced today). The `@storage "jsonb"` and `@storage absent` tests should PASS — they exercise the existing single-jsonb-column behavior.

- [ ] **Step 3: Add the flattening logic in `buildExpectedSchema`**

Open `server/typescript/packages/migrate-ts/src/expected-schema.ts`. Locate the column-building pass (search for `FIELD_SUBTYPE_OBJECT`). The current behavior: emit one `{ kind: "json" }` column per field-of-subtype-object. We need a branch: if `@storage` is `"flattened"`, instead walk `@objectRef` and emit prefixed columns.

Update the imports to include the new constants:

```typescript
import {
  // ... existing imports
  FIELD_ATTR_OBJECT_REF,
  FIELD_OBJECT_ATTR_STORAGE,
  STORAGE_FLATTENED,
  // ... existing
} from "@metaobjectsdev/metadata";
```

Find the loop that walks an entity's fields to build columns. Wherever it currently calls a per-field helper (e.g., `fieldToColumn(field)`), replace with a branch that may return MULTIPLE columns per field:

```typescript
function fieldsToColumns(entity: MetaData, root: MetaRoot): ColumnDescriptor[] {
  const out: ColumnDescriptor[] = [];
  for (const child of entity.ownChildren()) {
    if (child.type !== TYPE_FIELD) continue;
    if (child.subType === FIELD_SUBTYPE_OBJECT && readStorage(child) === STORAGE_FLATTENED) {
      out.push(...flattenObjectField(child, root));
    } else {
      out.push(fieldToColumn(child));
    }
  }
  return out;
}

function readStorage(field: MetaData): string | undefined {
  const v = field.ownAttr(FIELD_ATTR_STORAGE);
  return typeof v === "string" ? v : undefined;
}

function flattenObjectField(field: MetaData, root: MetaRoot): ColumnDescriptor[] {
  const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string" || ref.length === 0) return [];
  const targetObject = findObjectByName(root, ref);
  if (targetObject === undefined) return [];
  const prefix = resolveColumnName(field) + "_";
  const cols: ColumnDescriptor[] = [];
  for (const nested of targetObject.ownChildren()) {
    if (nested.type !== TYPE_FIELD) continue;
    const inner = fieldToColumn(nested);
    cols.push({ ...inner, name: prefix + inner.name });
  }
  return cols;
}

function findObjectByName(root: MetaRoot, name: string): MetaData | undefined {
  for (const child of root.ownChildren()) {
    if (child.type === TYPE_OBJECT && child.name === name) return child;
  }
  return undefined;
}
```

(Naming hints: `MetaRoot` and `findObjectByName` reuse whatever the existing file already imports; if `root: MetaRoot` is not already threaded through `buildTable` / `fieldsToColumns`, plumb it through — Task 4 of the schema-namespacing plan already passed `root as MetaRoot` to `buildTable`, so the parameter exists at the relevant call sites.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server/typescript/packages/migrate-ts && bun test expected-schema-field-object-storage.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Run the full migrate-ts suite for no regression**

```bash
cd server/typescript/packages/migrate-ts && bun test
```

Expected: all previously-passing tests still green. Field-object usage without `@storage` retains its existing single-jsonb-column behavior.

- [ ] **Step 6: Run workspace typecheck**

```bash
cd server/typescript && bun run --filter '*' typecheck
```

Expected: all packages exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/expected-schema.ts server/typescript/packages/migrate-ts/test/expected-schema-field-object-storage.test.ts
git commit -m "feat(migrate-ts): @storage \"flattened\" expands field.object @objectRef into prefixed columns"
```

---

## Task 5: Conformance fixture — `field-object-storage-flattened`

**Files:**
- Create: `fixtures/conformance/field-object-storage-flattened/input/meta.demo.json`
- Create: `fixtures/conformance/field-object-storage-flattened/expected.json`

- [ ] **Step 1: Create the input**

`fixtures/conformance/field-object-storage-flattened/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.value": {
          "name": "Address",
          "children": [
            { "field.string": { "name": "street", "@required": true } },
            { "field.string": { "name": "city",   "@required": true } },
            { "field.string": { "name": "postalCode" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Customer",
          "children": [
            { "source.dbTable": { "@name": "customers" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "shippingAddress", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Create the expected**

`fixtures/conformance/field-object-storage-flattened/expected.json` — same content as input, except `@fields` becomes the array form (per the existing fixture pattern):

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.value": {
          "name": "Address",
          "children": [
            { "field.string": { "name": "street", "@required": true } },
            { "field.string": { "name": "city",   "@required": true } },
            { "field.string": { "name": "postalCode" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Customer",
          "children": [
            { "source.dbTable": { "@name": "customers" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "shippingAddress", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 3: Run the conformance suite**

```bash
cd server/typescript && bun test --filter '*conformance*'
```

Expected: the new fixture PASSES. If the canonical-serializer output differs from `expected.json` (e.g., attr key ordering, whitespace), update `expected.json` to match — never modify `input/`. The fixture's contract is "input → canonical-serialize → expected."

- [ ] **Step 4: Commit**

```bash
git add fixtures/conformance/field-object-storage-flattened
git commit -m "test(conformance): add field-object-storage-flattened fixture"
```

---

## Task 6: Conformance fixture — `field-object-storage-flattened-nullable`

**Files:**
- Create: `fixtures/conformance/field-object-storage-flattened-nullable/input/meta.demo.json`
- Create: `fixtures/conformance/field-object-storage-flattened-nullable/expected.json`

- [ ] **Step 1: Create the input**

`fixtures/conformance/field-object-storage-flattened-nullable/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.value": {
          "name": "AddressOptional",
          "children": [
            { "field.string": { "name": "street" } },
            { "field.string": { "name": "city" } },
            { "field.string": { "name": "postalCode" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Person",
          "children": [
            { "source.dbTable": { "@name": "people" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "homeAddress", "@objectRef": "AddressOptional", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Create the expected**

`fixtures/conformance/field-object-storage-flattened-nullable/expected.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.value": {
          "name": "AddressOptional",
          "children": [
            { "field.string": { "name": "street" } },
            { "field.string": { "name": "city" } },
            { "field.string": { "name": "postalCode" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Person",
          "children": [
            { "source.dbTable": { "@name": "people" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "homeAddress", "@objectRef": "AddressOptional", "@storage": "flattened" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 3: Run conformance**

```bash
cd server/typescript && bun test --filter '*conformance*'
```

Expected: PASS. Adjust expected if serializer output differs.

- [ ] **Step 4: Commit**

```bash
git add fixtures/conformance/field-object-storage-flattened-nullable
git commit -m "test(conformance): add field-object-storage-flattened-nullable fixture"
```

---

## Task 7: Conformance fixture — `field-object-storage-jsonb-single`

**Files:**
- Create: `fixtures/conformance/field-object-storage-jsonb-single/input/meta.demo.json`
- Create: `fixtures/conformance/field-object-storage-jsonb-single/expected.json`

- [ ] **Step 1: Create the input**

`fixtures/conformance/field-object-storage-jsonb-single/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.value": {
          "name": "WorkflowConfig",
          "children": [
            { "field.string":  { "name": "mode" } },
            { "field.boolean": { "name": "verbose" } },
            { "field.int":     { "name": "maxRetries" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Program",
          "children": [
            { "source.dbTable": { "@name": "programs" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "workflowConfig", "@objectRef": "WorkflowConfig", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Create the expected**

`fixtures/conformance/field-object-storage-jsonb-single/expected.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.value": {
          "name": "WorkflowConfig",
          "children": [
            { "field.string":  { "name": "mode" } },
            { "field.boolean": { "name": "verbose" } },
            { "field.int":     { "name": "maxRetries" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Program",
          "children": [
            { "source.dbTable": { "@name": "programs" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "workflowConfig", "@objectRef": "WorkflowConfig", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 3: Run conformance + commit**

```bash
cd server/typescript && bun test --filter '*conformance*'
git add fixtures/conformance/field-object-storage-jsonb-single
git commit -m "test(conformance): add field-object-storage-jsonb-single fixture"
```

Expected: PASS. Adjust expected if needed.

---

## Task 8: Conformance fixture — `field-object-storage-jsonb-array`

**Files:**
- Create: `fixtures/conformance/field-object-storage-jsonb-array/input/meta.demo.json`
- Create: `fixtures/conformance/field-object-storage-jsonb-array/expected.json`

- [ ] **Step 1: Create the input**

`fixtures/conformance/field-object-storage-jsonb-array/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.value": {
          "name": "ContactInfo",
          "children": [
            { "field.string": { "name": "phone" } },
            { "field.string": { "name": "email" } },
            { "field.string": { "name": "preferredMethod" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Patient",
          "children": [
            { "source.dbTable": { "@name": "patients" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "contactInfos", "isArray": true, "@objectRef": "ContactInfo", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Create the expected**

`fixtures/conformance/field-object-storage-jsonb-array/expected.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.value": {
          "name": "ContactInfo",
          "children": [
            { "field.string": { "name": "phone" } },
            { "field.string": { "name": "email" } },
            { "field.string": { "name": "preferredMethod" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Patient",
          "children": [
            { "source.dbTable": { "@name": "patients" } },
            { "field.long":   { "name": "id" } },
            { "field.object": { "name": "contactInfos", "isArray": true, "@objectRef": "ContactInfo", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 3: Run conformance + commit**

```bash
cd server/typescript && bun test --filter '*conformance*'
git add fixtures/conformance/field-object-storage-jsonb-array
git commit -m "test(conformance): add field-object-storage-jsonb-array fixture"
```

Expected: PASS. Adjust expected if needed.

---

## Task 9: Document `@storage` in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `@storage` to the cross-language vocabulary list**

Open `CLAUDE.md`. Find the block:

```markdown
**Metamodel subtype vocabularies (must be identical across languages):**
- Filter operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`
- Source subtypes: `dbTable`, `dbView`
- Origin subtypes: `passthrough`, `aggregate`
- Layout subtypes: `dataGrid`
- Currency attrs: `@currency` (ISO 4217), `@locale` (BCP 47)
- Schema attrs: `@schema` on `source[dbTable]` and `source[dbView]` ...
```

(The Schema attrs line was added by the schema-namespacing plan.) Insert directly after the Schema attrs entry:

```markdown
- Storage attrs: `@storage` on `field.object` (with `@objectRef`) — values `flattened` / `jsonb` / `subdocument`. Unifies "owned types" (flattened storage) and "structured JSONB" (jsonb storage). Defaults to single-jsonb-column when absent (back-compat).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document @storage attr on field.object in cross-language vocabulary list"
```

---

## Task 10: Verify C# loader passes the new fixtures via opaque-attr passthrough

**Files:** none modified — verification only.

- [ ] **Step 1: Run the C# conformance suite**

```bash
cd server/csharp && dotnet test MetaObjects.Conformance.Tests
```

Expected: all C# tests pass, including the four new fixtures. The C# loader treats `@storage` as an opaque string attr (no per-attr code-path needed) and round-trips it through the canonical serializer unchanged.

- [ ] **Step 2: If a fixture fails on the C# side**

That would indicate the C# canonical serializer drops unknown attrs or doesn't preserve attr key ordering. File the divergence as a separate bug ticket; do NOT modify the fixtures to match C# behavior — TS is the canonical oracle per spec §7.2.

- [ ] **Step 3: Commit (verification report only — no code change)**

If verification passed cleanly, no commit needed. If you discovered an issue worth recording, add a short note in `docs/superpowers/specs/2026-05-20-csharp-tool-and-metamodel-extensions-design.md` under "Risks" and commit that doc edit.

---

## Self-Review

### 1. Spec coverage

The spec entry being implemented is the unified "Structured nested values via `object.value` + `@storage` hint" row in Tier 3 of `docs/superpowers/specs/2026-05-20-csharp-tool-and-metamodel-extensions-design.md`. Coverage:

- ✓ `@storage` attr declared with `flattened` / `jsonb` / `subdocument` enum — Tasks 1-2
- ✓ `isArray true` supported with `jsonb` and `subdocument`; rejected with `flattened` — Task 3
- ✓ `@storage "flattened"` emits multiple prefixed columns from the referenced `object.value` — Task 4
- ✓ `@storage "jsonb"` emits a single jsonb column (existing behavior; verified) — Task 4 test
- ✓ Subdocument mode acknowledged but no Postgres column emitted (existing behavior; no test needed since the metamodel doesn't dictate document-store behavior)
- ✓ Cross-language conformance via four fixtures — Tasks 5-8
- ✓ Documentation in `CLAUDE.md` — Task 9
- ✓ C# parity verified via existing opaque-attr passthrough — Task 10

### 2. Placeholder scan

No "TBD" / "implement later" / "handle edge cases" — every step has either explicit code, an explicit command with expected output, or an explicit assertion.

The phrase "before writing this verbatim, read core-attr-schemas.ts to confirm the existing patterns" in Task 3 Step 1 is grounded — the implementer must check the actual file to find where validation gets dispatched. This is intentional (the location is not stable across recent refactors) and is paired with an explicit fallback ("If there is no pattern, add a small post-load hook in this file").

### 3. Type consistency

- `FIELD_OBJECT_ATTR_STORAGE` declared in Task 1, used in Tasks 2-4
- `STORAGE_FLATTENED`, `STORAGE_JSONB`, `STORAGE_SUBDOCUMENT` declared in Task 1, used in Tasks 2-4
- `STORAGE_VALUES` array declared in Task 1, used in Task 2
- `validateFieldObjectStorage` defined in Task 3 Step 1, hooked in Task 3 Step 5
- `ERR_STORAGE_WITHOUT_OBJECT_REF`, `ERR_STORAGE_FLATTENED_ARRAY` registered in Task 3 Step 2, asserted in Task 3 Step 3
- `flattenObjectField` / `findObjectByName` / `readStorage` helpers defined together in Task 4 Step 3
- All fixture directory names match the spec's "Conformance corpus extensions" list exactly (`field-object-storage-flattened/`, `field-object-storage-flattened-nullable/`, `field-object-storage-jsonb-single/`, `field-object-storage-jsonb-array/`).

### 4. Scope check

Single focused unit — one new attr, four storage modes (three meaningful in Postgres + one "ignore for Postgres"), four fixtures, one docs update. Sized for a single subagent-driven execution cycle (~1 week including review iterations).

### 5. Ambiguity check

- Column-name prefixing convention: "the parent field's DB name + underscore + nested field's DB name." Task 4 Step 3 makes this concrete — `resolveColumnName(field) + "_"` then `nested.name` runs through `fieldToColumn` which already applies the project's column-naming strategy.
- Default behavior when `@storage` is absent: explicitly documented as "back-compat — single jsonb column" in Task 4 (test #4) and in the spec.
- Validator wiring (Task 3 Step 5): the implementer reads the existing file to find the right hook. This is a known per-file pattern check; the plan provides both the function shape (Step 1) and the call requirement (Step 5).

---

## Done When

- All 10 tasks committed, each with passing tests at the time of commit
- `cd server/typescript && bun test` is fully green
- `cd server/typescript && bun run --filter '*' typecheck` is fully green
- `cd server/csharp && dotnet test MetaObjects.Conformance.Tests` is fully green
- `CLAUDE.md` updated
- The four new conformance fixtures pass on both TS and C# runners
