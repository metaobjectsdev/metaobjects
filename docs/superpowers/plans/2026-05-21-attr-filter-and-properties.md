# `attr.filter` and `attr.properties` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the escaped-JSON-string `@filter` on `layout.dataGrid` with a typed, structural `attr.filter` value validated at load time, and complete the half-wired `attr.properties` subtype for Java parity.

**Architecture:** Extend the `AttrValue` union to admit JSON objects. Filter values desugar to a canonical `{ field: { op: value } }` shape at parse time (scalar→`eq`, array→`in`, `null`→`isNull`), so all four language ports and the conformance corpus see one canonical form. Filter validation moves from codegen time to a new loader validation pass that builds the allowlist from `@filterable` fields (the `OPS_BY_SUBTYPE` vocabulary already lives in the metadata package). Codegen stops parsing/validating and just emits the stored object. Cross-language ports (C#, Java) mirror the TS reference.

**Tech Stack:** TypeScript (Bun workspace at `server/typescript/`, `bun:test`), C# (`dotnet test`), Java (Maven, JUnit), JSON conformance fixtures at `fixtures/conformance/`.

**Spec:** `docs/superpowers/specs/2026-05-21-attr-filter-and-properties-design.md`

---

## Design refinements discovered during planning

These refine the spec without changing its intent — note them while executing:

1. **Desugaring is parse-time, not codegen-time.** Mirrors the existing `normalizeStringArrayAttr` precedent. The loaded tree (and therefore conformance `expected.json`) holds the canonical `{ field: { op: value } }` form. This makes the desugar rules cross-language-testable.
2. **`grid-filter-validate.ts` is superseded, not relocated.** The new load-time pass in `metadata/src/loader/validation-passes.ts` becomes the single home of filter validation. The old `codegen-ts-tanstack/src/grid-filter-validate.ts` is deleted (spec Decision D5's intent — "filter validation lives in metadata" — is satisfied by the loader pass).
3. **The hard break falls out of the type system.** A legacy string `@filter` value fails the existing attr-schema type check (`string` where `object`/`filter` expected) → `ERR_BAD_ATTR_VALUE`. No special-case code needed.
4. **The emitted codegen const changes shape** from `{ subscribed: true }` to the desugared `{ subscribed: { eq: true } }`. Functionally identical to `buildFilterQs` (which accepts both), but golden snapshots must be regenerated.

## File structure

**TS metadata package** (`server/typescript/packages/metadata/src/`):
- `meta/meta-data.ts` — extend `AttrValue` union with an `AttrObject` arm.
- `constants.ts` — add `ATTR_SUBTYPE_FILTER`; add to `ATTR_SUBTYPES`.
- `core-types.ts` — map `filter`→`DATA_TYPE_OBJECT` in `ATTR_DATA_TYPE`.
- `core-attr-schemas.ts` — change `LAYOUT_DATA_GRID_ATTR_FILTER` valueType to `filter`.
- `data-converter.ts` — pass objects through for `DATA_TYPE_OBJECT`.
- `parser-core.ts` — add `normalizeFilterAttr` parse-time desugar.
- `attr-schema-validate.ts` — fix `properties` (remove from string set); validate `object`-shaped attrs.
- `loader/validation-passes.ts` — add `validateDataGridFilterValues` pass.
- `loader/meta-data-loader.ts` — wire the new pass.
- `meta/meta-layout.ts` — `filter` accessor returns object; add `MetaAttr` properties helper if needed.

**TS codegen** (`server/typescript/packages/codegen-ts-tanstack/src/`):
- `templates/columns-file.ts` — consume the object; drop `JSON.parse` + validation.
- `grid-filter-validate.ts` — delete.

**Conformance** (`fixtures/conformance/`): six new fixtures + `CAPABILITIES.json` / `ERROR-CODES.json` updates.

**C#** (`server/csharp/MetaObjects/`): loader + canonical serializer object handling.

**Java** (`server/java/metadata/`): `FilterAttribute` + canonical JSON parser/serializer object handling.

---

# Phase 1 — TS metadata foundation

### Task 1: Extend `AttrValue` to admit objects

**Files:**
- Modify: `server/typescript/packages/metadata/src/meta/meta-data.ts:5`
- Test: `server/typescript/packages/metadata/test/attr-object-value.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/attr-object-value.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type { AttrValue, AttrObject } from "../src/meta/meta-data.js";

describe("AttrValue object arm", () => {
  it("accepts a nested object as a valid AttrValue", () => {
    const v: AttrValue = { subscribed: { eq: true } };
    expect(typeof v).toBe("object");
  });

  it("AttrObject permits nested arrays and nulls", () => {
    const o: AttrObject = { status: { in: ["a", "b"] }, deletedAt: { isNull: true } };
    expect(o.status).toEqual({ in: ["a", "b"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/attr-object-value.test.ts`
Expected: FAIL — `AttrObject` is not exported.

- [ ] **Step 3: Extend the union**

In `meta/meta-data.ts`, replace line 5 (`export type AttrValue = string | number | boolean | string[];`) with:

```ts
export type AttrValue = string | number | boolean | string[] | AttrObject;

/**
 * Object-shaped attr value (for `attr.filter` / `attr.properties`). Values are
 * arbitrary JSON so a filter can hold nested `{ op: value }` clauses (including
 * scalar arrays for `in` and `null` for `isNull`). Scalar/string[] attrs keep
 * their existing arms — this arm is reached only by object-typed attr subtypes.
 */
export type AttrObject = { readonly [key: string]: AttrJson };
export type AttrJson = string | number | boolean | null | AttrJson[] | AttrObject;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/attr-object-value.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck (the union widening may surface call sites)**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/metadata' typecheck`
Expected: PASS. If a switch over `AttrValue` now complains about an unhandled object case, note the file but do NOT fix yet — Tasks 4 and 8 cover validation and serialization. If typecheck fails in code unrelated to those, narrow with `typeof v === "object" && !Array.isArray(v)` guards at the failing site.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/meta/meta-data.ts server/typescript/packages/metadata/test/attr-object-value.test.ts
git commit -m "feat(metadata): admit object-shaped AttrValue (AttrObject arm)"
```

---

### Task 2: Add the `ATTR_SUBTYPE_FILTER` constant and register it

**Files:**
- Modify: `server/typescript/packages/metadata/src/constants.ts:116-136`
- Modify: `server/typescript/packages/metadata/src/core-types.ts:177-187`
- Test: `server/typescript/packages/metadata/test/attr-filter-subtype.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/attr-filter-subtype.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { TYPE_ATTR, ATTR_SUBTYPE_FILTER, ATTR_SUBTYPES } from "../src/constants.js";
import { DATA_TYPE_OBJECT } from "../src/data-type.js";

describe("attr.filter subtype", () => {
  it("is in ATTR_SUBTYPES", () => {
    expect(ATTR_SUBTYPES).toContain(ATTR_SUBTYPE_FILTER);
  });

  it("registers with DATA_TYPE_OBJECT", () => {
    const registry = composeRegistry(coreProviders());
    const def = registry.find(TYPE_ATTR, ATTR_SUBTYPE_FILTER);
    expect(def).toBeDefined();
    expect(def?.dataType).toBe(DATA_TYPE_OBJECT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/attr-filter-subtype.test.ts`
Expected: FAIL — `ATTR_SUBTYPE_FILTER` not exported.

- [ ] **Step 3: Add the constant**

In `constants.ts`, after `export const ATTR_SUBTYPE_PROPERTIES = "properties";` (line ~122) add:

```ts
export const ATTR_SUBTYPE_FILTER = "filter";
```

Add `ATTR_SUBTYPE_FILTER,` to the `ATTR_SUBTYPES` array (the `as const` array at lines ~125-135).

- [ ] **Step 4: Map the data type**

In `core-types.ts`, in the `ATTR_DATA_TYPE` map (lines ~177-187), add:

```ts
  [ATTR_SUBTYPE_FILTER]: DATA_TYPE_OBJECT,
```

Add `ATTR_SUBTYPE_FILTER` to the import block from `./constants.js` near the top of `core-types.ts` (where the other `ATTR_SUBTYPE_*` are imported).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/attr-filter-subtype.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/constants.ts server/typescript/packages/metadata/src/core-types.ts server/typescript/packages/metadata/test/attr-filter-subtype.test.ts
git commit -m "feat(metadata): register attr.filter subtype (object data type)"
```

---

### Task 3: Pass objects through `convertToDataType`

**Files:**
- Modify: `server/typescript/packages/metadata/src/data-converter.ts:23-42`
- Test: `server/typescript/packages/metadata/test/data-converter-object.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/data-converter-object.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { convertToDataType } from "../src/data-converter.js";
import { DATA_TYPE_OBJECT } from "../src/data-type.js";

describe("convertToDataType DATA_TYPE_OBJECT", () => {
  it("passes a plain object through unchanged", () => {
    const obj = { subscribed: true, status: ["a", "b"] };
    expect(convertToDataType(DATA_TYPE_OBJECT, obj)).toEqual(obj);
  });

  it("leaves a string value as a string (so schema validation can reject it)", () => {
    expect(convertToDataType(DATA_TYPE_OBJECT, '{"x":1}')).toBe('{"x":1}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/data-converter-object.test.ts`
Expected: FAIL — object is stringified to `"[object Object]"` by the `default` branch.

- [ ] **Step 3: Add the object branch**

In `data-converter.ts`, import `DATA_TYPE_OBJECT` (add to the existing import from `./data-type.js`). In `convertToDataType`, the leading `if (Array.isArray(raw)) return toStringArray(raw);` stays. Add a case before the `default` in the `switch`:

```ts
    case DATA_TYPE_OBJECT:
      // Object-typed attrs (filter / properties) store the object verbatim.
      // A non-object (e.g. a legacy JSON string) is returned as-is so the
      // attr-schema pass can reject it with ERR_BAD_ATTR_VALUE.
      return (typeof raw === "object" && raw !== null)
        ? (raw as AttrValue)
        : String(raw);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/data-converter-object.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/data-converter.ts server/typescript/packages/metadata/test/data-converter-object.test.ts
git commit -m "feat(metadata): pass objects through convertToDataType for object attrs"
```

---

### Task 4: Parse-time filter desugaring

**Files:**
- Modify: `server/typescript/packages/metadata/src/parser-core.ts:565-638`
- Test: `server/typescript/packages/metadata/test/filter-desugar.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/filter-desugar.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { LAYOUT_DATA_GRID_ATTR_FILTER, TYPE_OBJECT, TYPE_LAYOUT } from "../src/constants.js";

function loadGridFilter(filter: unknown): unknown {
  const doc = {
    "metadata.root": {
      package: "acme",
      children: [
        { "object.entity": { name: "Subscriber", children: [
          { "field.long": { name: "id" } },
          { "field.boolean": { name: "subscribed", "@filterable": true } },
          { "field.string": { name: "status", "@filterable": true } },
          { "field.string": { name: "deletedAt", "@filterable": true } },
          { "identity.primary": { "@fields": ["id"] } },
          { "layout.dataGrid": { name: "active", "@filter": filter, "@columns": ["status"] } },
        ] } },
      ],
    },
  };
  const loader = new MetaDataLoader();
  const root = loader.loadFromObjects([doc]);
  const obj = root.children().find((c) => c.type === TYPE_OBJECT)!;
  const layout = obj.children().find((c) => c.type === TYPE_LAYOUT)!;
  return layout.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
}

describe("filter desugaring", () => {
  it("scalar → eq", () => {
    expect(loadGridFilter({ subscribed: true })).toEqual({ subscribed: { eq: true } });
  });
  it("array → in", () => {
    expect(loadGridFilter({ status: ["active", "pending"] }))
      .toEqual({ status: { in: ["active", "pending"] } });
  });
  it("null → isNull", () => {
    expect(loadGridFilter({ deletedAt: null })).toEqual({ deletedAt: { isNull: true } });
  });
  it("explicit op object is left unchanged", () => {
    expect(loadGridFilter({ status: { like: "a%" } })).toEqual({ status: { like: "a%" } });
  });
});
```

> Note: confirm the loader's object-loading entry point name. If `loadFromObjects` does not exist, use the loader API the existing tests use (grep `loadFrom` in `test/` for the canonical call). Adjust the helper accordingly — the assertions are what matter.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/filter-desugar.test.ts`
Expected: FAIL — values come back un-desugared (e.g. `{ subscribed: true }`).

- [ ] **Step 3: Implement the desugar**

In `parser-core.ts`, add after `normalizeStringArrayAttr` (after line ~578):

```ts
// ---------------------------------------------------------------------------
// filter desugar — normalize an `attr.filter` value to canonical
// `{ field: { op: value } }` form at parse time. Three rules:
//   scalar v    → { eq: v }
//   array  [..] → { in: [..] }
//   null        → { isNull: true }
// Explicit `{ op: value }` clauses pass through. `or`/`and` composition keys
// recurse into their sub-filter arrays.
// ---------------------------------------------------------------------------

function normalizeFilterAttr(
  type: string,
  subType: string,
  attrName: string,
  value: AttrValue,
  registry: TypeRegistry,
): AttrValue {
  const spec = registry.attrsOf(type, subType).find((s) => s.name === attrName);
  if (spec === undefined || spec.valueType !== ATTR_SUBTYPE_FILTER) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return desugarFilterObject(value as Record<string, unknown>);
}

function desugarFilterObject(filter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(filter)) {
    if (key === "or" || key === "and") {
      out[key] = Array.isArray(raw)
        ? raw.map((sub) =>
            typeof sub === "object" && sub !== null && !Array.isArray(sub)
              ? desugarFilterObject(sub as Record<string, unknown>)
              : sub,
          )
        : raw;
      continue;
    }
    out[key] = desugarClause(raw);
  }
  return out;
}

function desugarClause(raw: unknown): Record<string, unknown> {
  if (raw === null) return { isNull: true };
  if (Array.isArray(raw)) return { in: raw };
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return { eq: raw };
}
```

Add `ATTR_SUBTYPE_FILTER` to the `./constants.js` import in `parser-core.ts`. Then in `applyInlineAttrsAndUnknownKeys`, change the normalization (around line 636) from:

```ts
    const normalized = normalizeStringArrayAttr(model.type, model.subType, attrName, value, registry);
    model.setAttr(attrName, normalized);
```

to:

```ts
    let normalized = normalizeStringArrayAttr(model.type, model.subType, attrName, value, registry);
    normalized = normalizeFilterAttr(model.type, model.subType, attrName, normalized, registry);
    model.setAttr(attrName, normalized);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/filter-desugar.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/parser-core.ts server/typescript/packages/metadata/test/filter-desugar.test.ts
git commit -m "feat(metadata): parse-time desugar of attr.filter to canonical op form"
```

---

### Task 5: Fix `attr.properties` type check + validate object attrs

**Files:**
- Modify: `server/typescript/packages/metadata/src/attr-schema-validate.ts:56-91`
- Test: `server/typescript/packages/metadata/test/attr-object-validate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/attr-object-validate.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { validateAttrSchema } from "../src/attr-schema-validate.js";
import { parseDocuments } from "../src/parser-core.js";

function errorsFor(filter: unknown): string[] {
  const registry = composeRegistry(coreProviders());
  const doc = {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Subscriber", children: [
        { "field.long": { name: "id" } },
        { "field.boolean": { name: "subscribed", "@filterable": true } },
        { "identity.primary": { "@fields": ["id"] } },
        { "layout.dataGrid": { name: "active", "@filter": filter, "@columns": [] } },
      ] } },
    ] },
  };
  const { root } = parseDocuments([doc], registry, { strict: false });
  return validateAttrSchema(root, registry).errors.map((e) => e.message);
}

describe("object attr schema validation", () => {
  it("accepts an object @filter value", () => {
    expect(errorsFor({ subscribed: true })).toEqual([]);
  });
  it("rejects a string @filter value (the legacy JSON-string form)", () => {
    const errs = errorsFor('{"subscribed":true}');
    expect(errs.some((m) => m.includes("@filter") && m.includes("filter"))).toBe(true);
  });
});
```

> Note: confirm `parseDocuments`'s exact name/signature by grepping existing parser tests (`grep -rn "parseDocuments\|parseDocument" test/`). Use whatever the existing tests call; the two assertions are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/attr-object-validate.test.ts`
Expected: FAIL — object value is rejected (properties/filter currently treated as string), so the "accepts object" case reports a spurious error.

- [ ] **Step 3: Fix the validator**

In `attr-schema-validate.ts`:

(a) Remove `ATTR_SUBTYPE_PROPERTIES` from `STRING_ATTR_SUBTYPES` (line ~65). Add `ATTR_SUBTYPE_FILTER` to the imports from `./constants.js`. Define an object-subtype set after `STRING_ATTR_SUBTYPES`:

```ts
const OBJECT_ATTR_SUBTYPES: ReadonlySet<AttrSubType> = new Set([
  ATTR_SUBTYPE_PROPERTIES,
  ATTR_SUBTYPE_FILTER,
]);
```

(b) In `valueMatchesType`, before the trailing `return true;`, add:

```ts
  if (OBJECT_ATTR_SUBTYPES.has(valueType)) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
```

(c) In `runtimeTypeName`, before the final `return typeof value;`, add:

```ts
  if (value !== null && typeof value === "object") return "object";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/attr-object-validate.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/attr-schema-validate.ts server/typescript/packages/metadata/test/attr-object-validate.test.ts
git commit -m "fix(metadata): validate object-shaped attrs (filter/properties), not as strings"
```

---

### Task 6: Load-time filter validation pass

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/validation-passes.ts`
- Modify: `server/typescript/packages/metadata/src/loader/meta-data-loader.ts:276`
- Test: `server/typescript/packages/metadata/test/validate-grid-filter-pass.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/validate-grid-filter-pass.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";

function loadErrors(doc: unknown): { code?: string; message: string }[] {
  const loader = new MetaDataLoader();
  loader.loadFromObjects([doc]);
  return loader.errors().map((e) => ({ code: (e as { code?: string }).code, message: e.message }));
}

function docWith(filter: unknown) {
  return {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Subscriber", children: [
        { "field.long": { name: "id" } },
        { "field.boolean": { name: "subscribed", "@filterable": true } },
        { "field.string": { name: "status", "@filterable": true } },
        { "field.string": { name: "notFilterable" } },
        { "identity.primary": { "@fields": ["id"] } },
        { "layout.dataGrid": { name: "active", "@filter": filter, "@columns": [] } },
      ] } },
    ] },
  };
}

describe("validateDataGridFilterValues", () => {
  it("accepts a filter over filterable fields", () => {
    expect(loadErrors(docWith({ subscribed: true, status: ["a"] }))).toEqual([]);
  });
  it("rejects a filter over a non-filterable field", () => {
    const errs = loadErrors(docWith({ notFilterable: "x" }));
    expect(errs.some((e) => e.code === "ERR_BAD_ATTR_FILTER")).toBe(true);
  });
  it("rejects a disallowed op for the field subtype (like on boolean)", () => {
    const errs = loadErrors(docWith({ subscribed: { like: "x%" } }));
    expect(errs.some((e) => e.code === "ERR_BAD_ATTR_FILTER")).toBe(true);
  });
});
```

> Note: confirm `loader.errors()` / `loadFromObjects` names against existing loader tests; adjust the helper if the API differs. The error-`code` assertions are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/validate-grid-filter-pass.test.ts`
Expected: FAIL — no `ERR_BAD_ATTR_FILTER` errors produced (pass doesn't exist).

- [ ] **Step 3: Implement the pass**

In `validation-passes.ts`, add to the `./constants.js` import: `LAYOUT_DATA_GRID_ATTR_FILTER`, `opsForSubType`. Append:

```ts
// ---------------------------------------------------------------------------
// Layout dataGrid @filter value validation
//
// Runs after extends: resolution (so inherited @filterable fields are visible)
// and after parse-time desugaring (so every clause is canonical { op: value }).
// Builds the allowlist from @filterable fields using OPS_BY_SUBTYPE, then checks
// every filtered field is filterable and every op is allowed for its subtype.
// ---------------------------------------------------------------------------

export function validateDataGridFilterValues(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    const effective = obj.children();
    const allow = new Map<string, readonly string[]>();
    for (const f of effective.filter((c) => c.type === TYPE_FIELD)) {
      if (f.ownAttr(FIELD_ATTR_FILTERABLE) === true) {
        allow.set(f.name, opsForSubType(f.subType));
      }
    }
    for (const layout of effective.filter(
      (c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID,
    )) {
      const filter = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
      // Type errors (e.g. legacy string form) are reported by validateAttrSchema.
      if (typeof filter !== "object" || filter === null || Array.isArray(filter)) continue;
      checkFilterClauses(filter as Record<string, unknown>, allow, obj.name, layout.name, errors);
    }
  }
  return errors;
}

function checkFilterClauses(
  filter: Record<string, unknown>,
  allow: Map<string, readonly string[]>,
  entityName: string,
  layoutName: string,
  errors: ParseError[],
): void {
  for (const [key, clause] of Object.entries(filter)) {
    if (key === "or" || key === "and") {
      if (Array.isArray(clause)) {
        for (const sub of clause) {
          if (typeof sub === "object" && sub !== null && !Array.isArray(sub)) {
            checkFilterClauses(sub as Record<string, unknown>, allow, entityName, layoutName, errors);
          }
        }
      }
      continue;
    }
    const allowedOps = allow.get(key);
    if (allowedOps === undefined) {
      errors.push(
        new ParseError(
          `dataGrid layout "${layoutName}" on entity "${entityName}" has @filter over ` +
            `non-filterable field "${key}". Filterable fields: ${[...allow.keys()].join(", ") || "(none)"}`,
          { code: "ERR_BAD_ATTR_FILTER" },
        ),
      );
      continue;
    }
    if (typeof clause === "object" && clause !== null && !Array.isArray(clause)) {
      for (const op of Object.keys(clause)) {
        if (!allowedOps.includes(op)) {
          errors.push(
            new ParseError(
              `dataGrid layout "${layoutName}" on entity "${entityName}" @filter uses disallowed ` +
                `op "${key}.${op}". Allowed ops for "${key}": ${allowedOps.join(", ")}`,
              { code: "ERR_BAD_ATTR_FILTER" },
            ),
          );
        }
      }
    }
  }
}
```

- [ ] **Step 4: Wire it into the loader**

In `meta-data-loader.ts`, add `validateDataGridFilterValues` to the import on line 18, and after the origin-paths pass (line 276) add:

```ts
      // Sixth-b pass: data-grid @filter value validation (field allowlist + op gating).
      errors.push(...validateDataGridFilterValues(root));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/validate-grid-filter-pass.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/loader/validation-passes.ts server/typescript/packages/metadata/src/loader/meta-data-loader.ts server/typescript/packages/metadata/test/validate-grid-filter-pass.test.ts
git commit -m "feat(metadata): load-time validation of dataGrid @filter values"
```

---

### Task 7: `MetaLayout.filter` returns an object

**Files:**
- Modify: `server/typescript/packages/metadata/src/meta/meta-layout.ts:48-52`
- Test: `server/typescript/packages/metadata/test/types/layout.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/typescript/packages/metadata/test/types/layout.test.ts` (inside the existing `describe`):

```ts
  it("filter accessor returns the desugared object", () => {
    // build/load a layout with @filter: { subscribed: true } using the same
    // loader helper this file already uses, then:
    // expect(layout.filter).toEqual({ subscribed: { eq: true } });
  });
```

Implement the test body using the file's existing loader/build helper (read the top of the file for the pattern). Assert `layout.filter` deep-equals `{ subscribed: { eq: true } }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/types/layout.test.ts`
Expected: FAIL — `filter` returns a string/undefined, type mismatch.

- [ ] **Step 3: Update the accessor**

In `meta-layout.ts`, replace the `filter` getter (lines 48-52) with:

```ts
  /** The desugared preset filter object for the dataGrid layout, or undefined. */
  get filter(): Record<string, unknown> | undefined {
    const v = this.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/types/layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/meta/meta-layout.ts server/typescript/packages/metadata/test/types/layout.test.ts
git commit -m "feat(metadata): MetaLayout.filter returns desugared object"
```

---

### Task 8: Serializer round-trips object attrs

**Files:**
- Test: `server/typescript/packages/metadata/test/serializer-object-attr.test.ts`
- Modify (only if test fails): `server/typescript/packages/metadata/src/serializer-json.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/serializer-object-attr.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { serializeJson } from "../src/serializer-json.js";

const doc = {
  "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Subscriber", children: [
      { "field.long": { name: "id" } },
      { "field.boolean": { name: "subscribed", "@filterable": true } },
      { "identity.primary": { "@fields": ["id"] } },
      { "layout.dataGrid": { name: "active", "@filter": { subscribed: true }, "@columns": [] } },
    ] } },
  ] },
};

describe("serializer object attr round-trip", () => {
  it("serializes @filter as an inline object and re-parses identically", () => {
    const loader = new MetaDataLoader();
    const root = loader.loadFromObjects([doc]);
    const json = serializeJson(root);
    expect(json).toContain('"@filter"');

    const loader2 = new MetaDataLoader();
    const root2 = loader2.loadFromObjects([JSON.parse(json)]);
    expect(serializeJson(root2)).toBe(json);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd server/typescript/packages/metadata && bun test test/serializer-object-attr.test.ts`
Expected: Likely PASS already (inline attrs dump the value verbatim). If it FAILS because `inferAttrSubType` is hit (child-node form) and mis-serializes the object, proceed to Step 3; otherwise skip to Step 4.

- [ ] **Step 3: (Only if failing) handle objects in `inferAttrSubType`**

In `serializer-json.ts`, in `inferAttrSubType`, before the final `return ATTR_SUBTYPE_STRING;`, add (import `ATTR_SUBTYPE_PROPERTIES`):

```ts
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return ATTR_SUBTYPE_PROPERTIES; // object-shaped attr (filter/properties)
  }
```

Re-run the test; expect PASS.

- [ ] **Step 4: Commit**

```bash
git add server/typescript/packages/metadata/test/serializer-object-attr.test.ts server/typescript/packages/metadata/src/serializer-json.ts
git commit -m "test(metadata): object attr serializer round-trip"
```

---

### Task 9: Full metadata-package regression

**Files:** none (verification task)

- [ ] **Step 1: Run the whole metadata package suite**

Run: `cd server/typescript/packages/metadata && bun test`
Expected: PASS. The `@filter`-as-string assumption may break existing tests that author a string `@filter`. For each failure, update the test's metadata to the object form (`"@filter": { ... }`) — this is the intended hard break.

- [ ] **Step 2: Typecheck the package**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/metadata' typecheck`
Expected: PASS

- [ ] **Step 3: Commit any test migrations**

```bash
git add -A server/typescript/packages/metadata/test
git commit -m "test(metadata): migrate string @filter fixtures to object form"
```

---

# Phase 2 — TS codegen

### Task 10: Codegen consumes the filter object; delete the codegen-side validator

**Files:**
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/templates/columns-file.ts`
- Delete: `server/typescript/packages/codegen-ts-tanstack/src/grid-filter-validate.ts`

- [ ] **Step 1: Update `extractGrids` to read the object**

In `columns-file.ts`:
- Change `GridSpec.filter` type from `string` to `Record<string, unknown>`.
- Replace line 117 (`if (typeof filterAttr === "string" && filterAttr.length > 0) grid.filter = filterAttr;`) with:

```ts
    if (typeof filterAttr === "object" && filterAttr !== null && !Array.isArray(filterAttr)) {
      grid.filter = filterAttr as Record<string, unknown>;
    }
```

- [ ] **Step 2: Drop parsing + validation in `renderColumnsFile`**

Replace the filter-const block (lines 170-190) with:

```ts
    // Emit per-grid filter const when @filter is set. The value is already a
    // desugared, load-time-validated object — emit it verbatim.
    let filterConstCode: Code | null = null;
    if (grid.filter !== undefined) {
      const filterConstName = `${lcEntity}${capitalize(grid.name)}Filter`;
      hasFilterConst = true;
      filterConstCode = code`
export const ${filterConstName}: ${entityName}Filter = ${JSON.stringify(grid.filter, null, 2)};
`;
    }
```

Remove the now-unused `buildAllowlistForEntity` function (lines 37-49), the `entityAllowlist` local (line 144), and these imports: `validateGridFilter`, `FilterAllowlist` (line 16), `FIELD_ATTR_FILTERABLE`, `opsForSubType` (lines 11-12).

- [ ] **Step 3: Delete the codegen-side validator**

```bash
git rm server/typescript/packages/codegen-ts-tanstack/src/grid-filter-validate.ts
```

- [ ] **Step 4: Typecheck**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/codegen-ts-tanstack' typecheck`
Expected: PASS. If anything else imported `grid-filter-validate.js`, grep and remove those imports.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts-tanstack/src/templates/columns-file.ts
git commit -m "refactor(codegen-ts-tanstack): consume desugared @filter object; drop codegen-time validation"
```

---

### Task 11: Regenerate golden snapshots + migrate codegen test fixtures

**Files:**
- Modify: codegen-ts-tanstack test fixtures that author a string `@filter`.
- Modify: `server/typescript/packages/codegen-ts-tanstack/test/golden/__snapshots__/*`

- [ ] **Step 1: Find string `@filter` usages in codegen tests**

Run: `grep -rn '"@filter"' server/typescript/packages/codegen-ts-tanstack/test`
For each hit authoring a JSON string, rewrite to the object form (e.g. `"@filter": { "subscribed": true }`).

- [ ] **Step 2: Run the codegen suite (expect snapshot diffs)**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test`
Expected: FAIL on golden snapshots — the emitted const is now `{ subscribed: { eq: true } }` instead of `{ subscribed: true }`.

- [ ] **Step 3: Inspect, then update snapshots**

Inspect one failing diff to confirm the only change is the desugared filter shape (and nothing unexpected). Then update snapshots:

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test --update-snapshots`
Expected: PASS after update.

- [ ] **Step 4: Re-run to confirm green**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts-tanstack/test
git commit -m "test(codegen-ts-tanstack): regenerate goldens for desugared @filter"
```

---

### Task 12: Whole-monorepo TS verification

**Files:** none (verification)

- [ ] **Step 1: Full TS test run**

Run: `cd server/typescript && bun test`
Expected: PASS. Fix any remaining string-`@filter` authoring in other packages by migrating to object form.

- [ ] **Step 2: Full typecheck**

Run: `cd server/typescript && bun run --filter '*' typecheck`
Expected: PASS

- [ ] **Step 3: Commit any stragglers**

```bash
git add -A server/typescript
git commit -m "test(ts): migrate remaining string @filter usages to object form"
```

---

# Phase 3 — Conformance fixtures, manifests, migration

### Task 13: Add success conformance fixtures

**Files:**
- Create: `fixtures/conformance/attr-filter-shorthand/input/meta.users.json`
- Create: `fixtures/conformance/attr-filter-shorthand/expected.json`
- Create: `fixtures/conformance/attr-filter-explicit-ops/input/meta.users.json`
- Create: `fixtures/conformance/attr-filter-explicit-ops/expected.json`
- Create: `fixtures/conformance/attr-properties-basic/input/meta.users.json`
- Create: `fixtures/conformance/attr-properties-basic/expected.json`

- [ ] **Step 1: Author `attr-filter-shorthand` input**

`fixtures/conformance/attr-filter-shorthand/input/meta.users.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "field.long": { "name": "id" } },
        { "field.boolean": { "name": "subscribed", "@filterable": true } },
        { "field.string": { "name": "status", "@filterable": true } },
        { "field.string": { "name": "deletedAt", "@filterable": true } },
        { "identity.primary": { "@fields": ["id"] } },
        { "layout.dataGrid": { "name": "active",
          "@filter": { "subscribed": true, "status": ["active", "pending"], "deletedAt": null },
          "@columns": ["status"] } }
      ] } }
    ]
  }
}
```

- [ ] **Step 2: Generate the canonical `expected.json`**

The `expected.json` is the canonical serialization of the loaded tree. Rather than hand-write it, generate it with the TS serializer and paste the result. Run:

```bash
cd server/typescript/packages/metadata && bun -e '
import { MetaDataLoader } from "./src/loader/meta-data-loader.js";
import { serializeJson } from "./src/serializer-json.js";
const doc = await Bun.file("../../../../fixtures/conformance/attr-filter-shorthand/input/meta.users.json").json();
const loader = new MetaDataLoader();
const root = loader.loadFromObjects([doc]);
console.log(serializeJson(root));
'
```

Verify the `@filter` in the output is the desugared form (`{ "subscribed": { "eq": true }, "status": { "in": ["active","pending"] }, "deletedAt": { "isNull": true } }`). Write that output to `fixtures/conformance/attr-filter-shorthand/expected.json`.

> If the loader API names differ, adjust the inline script to match Task 4/6's confirmed API.

- [ ] **Step 3: Author `attr-filter-explicit-ops`**

Input identical structure, with a `createdAt` filterable string field and:

```json
"@filter": { "createdAt": { "gte": "2024-01-01" }, "status": { "like": "act%" } }
```

Generate its `expected.json` the same way (explicit ops pass through unchanged).

- [ ] **Step 4: Author `attr-properties-basic`**

Input with an entity carrying an object-valued `attr.properties`. Since no built-in node declares a `properties` attr yet, exercise it as an **undeclared** inline attr OR via a node that accepts arbitrary attrs. Author:

```json
{ "object.entity": { "name": "Subscriber", "@meta": { "owner": "growth", "tier": "gold" }, "children": [
  { "field.long": { "name": "id" } },
  { "identity.primary": { "@fields": ["id"] } }
] } }
```

> `@meta` here is an undeclared object attr — it stores verbatim. Confirm undeclared object attrs are accepted (Task 3's `toAttrValue` path may reject objects). If `toAttrValue` rejects objects, extend it to pass objects through (mirror the Task 3 change): add `if (typeof raw === "object" && !Array.isArray(raw)) return raw as AttrValue;` before the throw in `toAttrValue`, with a one-line test in `test/data-converter-object.test.ts`, then regenerate. Generate `expected.json` as in Step 2.

- [ ] **Step 5: Run the TS conformance suite**

Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts`
Expected: PASS for the three new `conformance:` + `lint:` tests.

- [ ] **Step 6: Commit**

```bash
git add fixtures/conformance/attr-filter-shorthand fixtures/conformance/attr-filter-explicit-ops fixtures/conformance/attr-properties-basic server/typescript/packages/metadata/src/data-converter.ts server/typescript/packages/metadata/test/data-converter-object.test.ts
git commit -m "test(conformance): add attr.filter + attr.properties success fixtures"
```

---

### Task 14: Add error conformance fixtures + update manifests

**Files:**
- Create: `fixtures/conformance/error-attr-filter-bad-field/{input/meta.users.json,expected-errors.json}`
- Create: `fixtures/conformance/error-attr-filter-bad-op/{input/meta.users.json,expected-errors.json}`
- Create: `fixtures/conformance/error-attr-filter-legacy-string/{input/meta.users.json,expected-errors.json}`
- Modify: `fixtures/conformance/ERROR-CODES.json`
- Modify: `fixtures/conformance/CAPABILITIES.json`

- [ ] **Step 1: Register the new error code**

In `fixtures/conformance/ERROR-CODES.json`, add to the `codes` object:

```json
    "ERR_BAD_ATTR_FILTER": "A dataGrid @filter references a non-filterable field or a disallowed operator for the field's subtype.",
```

- [ ] **Step 2: Author `error-attr-filter-bad-field`**

Input: a dataGrid `@filter` over a field that is NOT `@filterable`. `expected-errors.json`:

```json
[ { "code": "ERR_BAD_ATTR_FILTER" } ]
```

- [ ] **Step 3: Author `error-attr-filter-bad-op`**

Input: `"@filter": { "subscribed": { "like": "x%" } }` where `subscribed` is a filterable `field.boolean` (boolean allows only `eq`/`isNull`). `expected-errors.json`:

```json
[ { "code": "ERR_BAD_ATTR_FILTER" } ]
```

- [ ] **Step 4: Author `error-attr-filter-legacy-string`**

Input: the old form `"@filter": "{\"subscribed\":true}"`. `expected-errors.json`:

```json
[ { "code": "ERR_BAD_ATTR_VALUE" } ]
```

- [ ] **Step 5: Add capabilities**

In `fixtures/conformance/CAPABILITIES.json`, add to the `capabilities` array:

```json
    "attr.filter",
    "attr.properties"
```

- [ ] **Step 6: Run the TS conformance suite**

Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts`
Expected: PASS for all six new fixtures.

- [ ] **Step 7: Guard C# CI — list new fixtures as known-gaps until Phase 4**

In `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`, set `fixtures` to the six new fixture names (so C# `dotnet test` treats them as known-gaps, staying green):

```json
{
  "language": "csharp",
  "fixtures": [
    "attr-filter-shorthand",
    "attr-filter-explicit-ops",
    "attr-properties-basic",
    "error-attr-filter-bad-field",
    "error-attr-filter-bad-op",
    "error-attr-filter-legacy-string"
  ]
}
```

> Confirm the ledger's array semantics (a listed fixture = "allowed to fail"). Read `server/csharp/MetaObjects.Conformance.Tests/ExpectedFailures.cs` to verify the field name and matching behavior before editing.

- [ ] **Step 8: Commit**

```bash
git add fixtures/conformance/error-attr-filter-bad-field fixtures/conformance/error-attr-filter-bad-op fixtures/conformance/error-attr-filter-legacy-string fixtures/conformance/ERROR-CODES.json fixtures/conformance/CAPABILITIES.json server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json
git commit -m "test(conformance): add attr.filter error fixtures; gate C# as known-gap"
```

---

### Task 15: Migrate in-repo metadata (the downstream consumer + any others)

**Files:** project metadata files using string `@filter`.

- [ ] **Step 1: Find all string `@filter` usages repo-wide**

Run: `grep -rn '"@filter": *"' --include=*.json . | grep -v node_modules | grep -v /dist/`
This finds the escaped-string form (object form has `"@filter": {`).

- [ ] **Step 2: Convert each to object form**

For each match, replace the escaped JSON string with the equivalent object. Example — `"@filter": "{\"subscribed\":true}"` becomes `"@filter": { "subscribed": true }`. (Authoring shorthand is fine; the loader desugars.)

- [ ] **Step 3: Verify the downstream consumer loads clean**

If the downstream consumer has a load/gen check, run it (e.g. its `meta gen --dry-run`). Expected: no `ERR_BAD_ATTR_VALUE` / `ERR_BAD_ATTR_FILTER`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: migrate string @filter metadata to typed object form"
```

---

# Phase 4 — C# port

### Task 16: C# loader + serializer handle object-valued attrs

**Files:**
- Modify: `server/csharp/MetaObjects/CoreAttrSchemas.cs` (filter subtype + dataGrid `@filter` valueType)
- Modify: `server/csharp/MetaObjects/Loader/*` (JSON parser: object attr values + filter desugar)
- Modify: `server/csharp/MetaObjects/Meta/*` (canonical serializer: emit object inline)
- Modify: `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`

- [ ] **Step 1: Read the C# attr-handling code**

Read `CoreAttrSchemas.cs`, the C# JSON loader/parser, and the canonical serializer to mirror the TS changes. Identify where attr values are coerced and where the `@filter` schema entry lives.

- [ ] **Step 2: Add `filter` subtype + retype `@filter`**

Mirror Tasks 2 + the `core-attr-schemas` change: register an `attr.filter` subtype (object data type) and set the dataGrid `@filter` valueType to `filter`. Register `attr.properties` object handling if not already present.

- [ ] **Step 3: Object attr values + parse-time desugar in the C# parser**

Mirror Tasks 3 + 4: store object attr values verbatim; desugar `attr.filter` to canonical `{ field: { op: value } }` (scalar→eq, array→in, null→isNull). Mirror the load-time field/op validation (Task 6) emitting `ERR_BAD_ATTR_FILTER`, and the string-form rejection via the existing attr type check (`ERR_BAD_ATTR_VALUE`).

- [ ] **Step 4: Canonical serializer emits objects inline**

Ensure the C# canonical serializer emits an object `@filter` identically to TS (same key order, same desugared values) so `expected.json` matches byte-for-byte.

- [ ] **Step 5: Remove the C# known-gap entries**

Set `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json` `fixtures` back to `[]`.

- [ ] **Step 6: Run C# conformance**

Run: `cd server/csharp && dotnet test`
Expected: PASS, including the six new fixtures (now off the ledger).

- [ ] **Step 7: Commit**

```bash
git add server/csharp
git commit -m "feat(csharp): support attr.filter + attr.properties in loader and serializer"
```

---

# Phase 5 — Java port

### Task 17: Java `FilterAttribute` + canonical JSON handling

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/attr/FilterAttribute.java`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/attr/AttributeTypesMetaDataProvider.java`
- Modify: Java canonical JSON parser + serializer (the classes covered by `CanonicalJsonParserTest` / `CanonicalJsonSerializerTest`)
- Test: a new unit test alongside the canonical JSON tests

- [ ] **Step 1: Write the failing Java test**

Add a test (mirroring `CanonicalJsonParserTest`) that loads a dataGrid with `@filter: { subscribed: true }` and asserts the parsed/serialized canonical form is `{ subscribed: { eq: true } }`, plus a properties round-trip. Run the relevant test class:

Run: `cd server/java && mvn -q -pl metadata test -Dtest=CanonicalJsonParserTest`
Expected: FAIL (filter not desugared / object attr not handled).

- [ ] **Step 2: Add `FilterAttribute`**

Create `FilterAttribute.java` modeled on `PropertiesAttribute.java`: subtype `filter`, `DataTypes.CUSTOM`, value backed by a parsed JSON object (e.g. a `Map<String,Object>`), with `setValueAsString`/`setValueAsObject` accepting an object and rejecting bare strings (the hard break). Register it in `AttributeTypesMetaDataProvider.registerTypes` next to `PropertiesAttribute.registerTypes(registry);`.

- [ ] **Step 3: Desugar + canonical serialization in the Java JSON layer**

In the canonical JSON parser, when an attr's subtype is `filter`, desugar to canonical op form (scalar→eq, array→in, null→isNull). In the serializer, emit the object inline with the same key order as TS. Properties already round-trips via `PropertiesAttribute`; verify it emits an object (not a `.properties` string) to match the cross-language `expected.json`.

- [ ] **Step 4: Run the Java test**

Run: `cd server/java && mvn -q -pl metadata test -Dtest=CanonicalJsonParserTest,CanonicalJsonSerializerTest`
Expected: PASS

- [ ] **Step 5: Full Java metadata module test**

Run: `cd server/java && mvn -q -pl metadata test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/java
git commit -m "feat(java): add FilterAttribute + canonical attr.filter/properties handling"
```

---

## Self-Review

**Spec coverage check:**
- Replace escaped-string `@filter` with typed value → Tasks 2, 4, 7, 10. ✓
- Standard shorthand (scalar→eq, array→in, null→isNull) → Task 4 + fixtures (Task 13). ✓
- Validation moved to load time → Task 6. ✓
- Complete `attr.properties` (fix string mis-validation + parity) → Tasks 5, 13 (Step 4), 16, 17. ✓
- Hard break on legacy string form → Task 5 (falls out of type check) + fixture (Task 14, Step 4). ✓
- `attr.filter` restricted to `layout.dataGrid` (D2) → only the dataGrid `@filter` schema entry is retyped; no other node gets the attr. ✓
- `grid-filter-validate` lives in metadata (D5) → superseded by load-time pass; codegen file deleted (Task 10). ✓
- Cross-language fixtures (TS/Java/C#) → Tasks 13, 14, 16, 17. ✓
- Migrate the downstream consumer → Task 15. ✓
- CAPABILITIES.json / ERROR-CODES.json updates → Task 14. ✓

**Placeholder scan:** No "TBD"/"implement later". The few "confirm the API name" notes point at concrete grep targets (loader entry points, ledger field) because exact private method names weren't read during planning — each carries the fallback to grep existing tests, and the assertion/contract is always spelled out.

**Type consistency:** `AttrValue`/`AttrObject`/`AttrJson` (Task 1) used consistently; `validateDataGridFilterValues` / `checkFilterClauses` names match between Task 6 definition and the loader wiring; `ERR_BAD_ATTR_FILTER` used in Task 6 and registered in Task 14; the desugared shape `{ field: { op: value } }` is consistent across desugar (Task 4), validation (Task 6), accessor (Task 7), codegen (Task 10), and fixtures (Tasks 13-14).

**Open verification items for the executor (cheap to confirm, flagged inline):**
- Loader object-loading entry point name (`loadFromObjects` / `loader.errors()`) — grep existing loader tests.
- Parser test entry point name (`parseDocuments`) — grep existing parser tests.
- C# ledger field name + match semantics — read `ExpectedFailures.cs`.
- Whether undeclared object attrs need `toAttrValue` widening (Task 13 Step 4) — the test will tell.
