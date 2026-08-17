# Int-Backed Enum Values — Metamodel Implementation Plan

> **STATUS — SUPERSEDED, kept for provenance.** This plan is IMPLEMENTED; the shipped
> behaviour is in
> [`docs/superpowers/specs/2026-07-23-int-backed-enum-values-design.md`](../specs/2026-07-23-int-backed-enum-values-design.md),
> which is the source of truth. Two things below are now WRONG and must not be followed:
> **(1) D7 is reversed** — int-backing is scalar-only, and `@intValueMap` with `isArray`
> is a load error (`ERR_ENUM_INT_VALUE_MAP_ARRAY`) in every port, so every array-of-enum
> fixture, column shape and element-wise codec sketched here describes vocabulary that
> cannot load. **(2) Some sketched tests call APIs that do not exist** (e.g.
> `MetaRoot.find_object`, `MetaObject.field(name)`) or assume test libraries a module does
> not depend on. Read the shipped code and its tests, not these snippets.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `@intValueMap` attribute to `field.enum` — an optional `{memberSymbol: int}` map that, when present, is the metadata author's declaration of each member's stored integer — across all five ports (TypeScript, C#, Java, Python, Kotlin-via-Java), gated by load-time validation and the `registry-conformance` + `fixtures/conformance/` corpora. This plan covers **vocabulary + validation + conformance only** — it does NOT touch codegen (already proven unchanged, since no port's enum-type emitter reads `@intValueMap`) or persistence (DB DDL, EF Core/JDBC/Exposed/ObjectManager codecs, migrate-ts's migration-safety guard). Those are covered by follow-on plans, one per port/group, written after this one lands.

**Architecture:** Each port already has an identical three-layer structure for `field.enum`'s existing `@values` attribute: (1) a generic attr-value-type class/registration (`properties`, `string[]`, etc.) that enforces the attr's basic shape, (2) a field.enum-specific content-rule validation pass that enforces the enum's own semantics (non-empty, identifier pattern, no duplicates) on top of that shape, (3) a shared cross-port conformance fixture set + a shared `registry-conformance` manifest that every port's test suite asserts against byte-for-byte. `@intValueMap` follows the exact same three-layer shape, with one port-specific correction: Java's existing `properties` attr class is backed by `java.util.Properties`, which silently coerces every value to a `String` on load (confirmed by reading `PropertiesAttribute.java:51-60` — every `Map` entry is written via `.getValue().toString()`). Reusing it for `@intValueMap` would silently turn `0` into `"0"` internally in Java, and — because canonical-JSON round-trip serialization must be byte-identical across ports (the `fixtures/conformance/*/expected.json` gate) — would make Java re-emit an integer value as a quoted JSON string, diverging from TS/C#/Python. So every port registers a **new**, cross-port-identical attr subtype, `intMap` (a generic "object with all-integer values" shape, parallel to how `properties` is a generic "any object" shape), and Java backs it with a new `Map<String,Integer>`-typed class instead of reusing `PropertiesAttribute`. `field.enum`'s own content-rule pass then layers the enum-specific rules on top: `@intValueMap`'s key set must exactly equal `@values`' members, and no two members may share a stored int (reusing the existing `ERR_BAD_ATTR_VALUE` code everywhere — no new error code needed, confirmed by inspecting all four ports' error-code ledgers).

**Tech Stack:** TypeScript (Bun test runner), C# (.NET, xunit), Java (Maven, JUnit) — also covers Kotlin, which shares Java's metadata layer — Python (pytest).

## Global Constraints

- Cross-language contract (from the design spec, `docs/superpowers/specs/2026-07-23-int-backed-enum-values-design.md`): attribute name is `intValueMap` (canonical JSON `@intValueMap`); value shape is an object with string keys (member symbols) and integer values; every loader enforces identically: (a) key set exactly equals `@values`' members (no missing, no extra), (b) every value is an integer, (c) no two members share a value.
- No new `@kind`. Presence of `@intValueMap` alone is the only signal — do not add a discriminator attribute.
- `@values` is completely untouched — do not modify its required-ness, type, or any existing validation for it.
- Reuse `ERR_BAD_ATTR_VALUE` for every `@intValueMap` content violation (confirmed: no port has a dedicated enum error code today — all enum content violations already reuse this code).
- Every new attr/field-attr registration needs a `registry-conformance` fixture entry (ADR-0023) — `fixtures/registry-conformance/expected-registry.json` is the ONE shared file all five ports assert against.
- `fixtures/conformance/` fixtures are shared JSON, consumed by every port's own test runner — write them once, verify per-port.
- Do NOT touch codegen or persistence in this plan. If a task tempts you to edit a `*Generator.cs`/`*.ts` codegen template, a DDL emitter, or an ORM config generator, stop — that belongs to a follow-on plan.

---

### Task 1: TypeScript — generic `attr.intMap` subtype

**Files:**
- Modify: `spec/metamodel/attr.json`
- Create: `server/typescript/packages/metadata/src/core/attr/meta-attr-int-map.ts`
- Modify: `server/typescript/packages/metadata/src/core/attr/attr-constants.ts`
- Modify: `server/typescript/packages/metadata/src/core-types.ts`
- Test: `server/typescript/packages/metadata/test/core/attr/meta-attr-int-map.test.ts`

**Interfaces:**
- Produces: `ATTR_SUBTYPE_INT_MAP = "intMap"` (exported from `attr-constants.ts`), the `IntMapAttr` class (registered against that subtype), and the `attr.intMap` type declaration in the canonical spec — all consumed by Task 2.

- [ ] **Step 1: Write the failing test**

```typescript
// server/typescript/packages/metadata/test/core/attr/meta-attr-int-map.test.ts
import { describe, test, expect } from "bun:test";
import { IntMapAttr } from "../../../src/core/attr/meta-attr-int-map.js";

describe("IntMapAttr", () => {
  test("accepts a plain object with integer values", () => {
    const attr = new IntMapAttr("intValueMap");
    attr.setValue({ DRAFT: 0, PUBLISHED: 5 });
    expect(attr.validateValue(attr.getValue())).toEqual([]);
  });

  test("rejects a non-object value", () => {
    const attr = new IntMapAttr("intValueMap");
    const errors = attr.validateValue("not-an-object" as unknown as object);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain("must be of type 'intMap'");
  });

  test("rejects an array value", () => {
    const attr = new IntMapAttr("intValueMap");
    const errors = attr.validateValue([0, 1] as unknown as object);
    expect(errors.length).toBe(1);
  });

  test("rejects a non-integer value", () => {
    const attr = new IntMapAttr("intValueMap");
    const errors = attr.validateValue({ DRAFT: "0" } as unknown as object);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain("DRAFT");
  });

  test("rejects a float value", () => {
    const attr = new IntMapAttr("intValueMap");
    const errors = attr.validateValue({ DRAFT: 0.5 } as unknown as object);
    expect(errors.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript && bun test packages/metadata/test/core/attr/meta-attr-int-map.test.ts`
Expected: FAIL — `Cannot find module '../../../src/core/attr/meta-attr-int-map.js'`

- [ ] **Step 3: Add `ATTR_SUBTYPE_INT_MAP` to `attr-constants.ts`**

Edit `server/typescript/packages/metadata/src/core/attr/attr-constants.ts` — add the constant next to `ATTR_SUBTYPE_EXPRESSION` (line 19) and into the `ATTR_SUBTYPES` array (line 33-44):

```typescript
export const ATTR_SUBTYPE_EXPRESSION = "expression";
// An object-shaped attr whose values are all integers (e.g. field.enum's
// @intValueMap: {memberSymbol: int}). Generic shape check only — semantic
// rules specific to a consumer (key-set membership, uniqueness) are that
// consumer's own content-rule validation, not this attr's.
export const ATTR_SUBTYPE_INT_MAP = "intMap";
```

```typescript
export const ATTR_SUBTYPES = [
  SUBTYPE_BASE,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_PROPERTIES,
  ATTR_SUBTYPE_FILTER,
  ATTR_SUBTYPE_EXPRESSION,
  ATTR_SUBTYPE_INT_MAP,
] as const;
```

- [ ] **Step 4: Write `meta-attr-int-map.ts`**

```typescript
// IntMapAttr — attr subtype `intMap`. Object-shaped value whose members must
// all be integers (e.g. field.enum's @intValueMap). No desugar; validates
// shape (object, not array) and every value's type (integer). A consumer's
// own semantic rules (key-set membership, uniqueness) are validated by that
// consumer, not here — mirrors how StringArrayAttr validates shape while
// field.enum's own content-rule pass validates its @values semantics.

import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "../../shared/meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../../data-type.js";
import { registerAttrClass } from "../../attr-class-map.js";
import { ATTR_SUBTYPE_INT_MAP } from "./attr-constants.js";

export class IntMapAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_OBJECT;
  }

  override coerce(raw: unknown): AttrValue {
    return raw as AttrValue;
  }

  override validateValue(value: AttrValue): ValueError[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [{ message: `attribute '@${this.name}' must be of type 'intMap' but got ${runtimeTypeName(value)}` }];
    }
    const errors: ValueError[] = [];
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (typeof member !== "number" || !Number.isInteger(member)) {
        errors.push({
          message: `attribute '@${this.name}' member '${key}' has value '${String(member)}' which is not an integer`,
        });
      }
    }
    return errors;
  }
}

registerAttrClass(ATTR_SUBTYPE_INT_MAP, IntMapAttr);
```

- [ ] **Step 5: Import the new module for its registration side-effect**

Edit `server/typescript/packages/metadata/src/core-types.ts` — add alongside the existing sibling imports (line 20-22):

```typescript
import "./core/attr/meta-attr-filter.js";
import "./core/attr/meta-attr-properties.js";
import "./core/attr/meta-attr-expression.js";
import "./core/attr/meta-attr-int-map.js";
```

- [ ] **Step 6: Add the `attr.intMap` type declaration to the canonical spec**

Edit `spec/metamodel/attr.json` — insert alphabetically between the `int` and `long` subtype blocks:

```json
    {
      "type": "attr",
      "subType": "intMap",
      "dataType": "object",
      "description": "An object-shaped attribute whose values are all integers (e.g. field.enum's @intValueMap: {memberSymbol: int}). Generic shape check only; a consumer field type layers its own semantic rules (key-set membership, uniqueness) in its own content-rule validation."
    },
```

- [ ] **Step 7: Regenerate the embedded attr definition**

Run: `cd <repo-root> && bun scripts/generate-embedded-metamodel.ts`
Expected: regenerates `server/typescript/packages/metadata/src/core/attr/attr-definition.embedded.ts` to include the new `intMap` block.

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd server/typescript && bun test packages/metadata/test/core/attr/meta-attr-int-map.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 9: Run the full metadata test suite to check for regressions**

Run: `cd server/typescript && bun test packages/metadata`
Expected: all existing tests still pass (this step only adds a new subtype; nothing existing should change behavior).

- [ ] **Step 10: Commit**

```bash
git add spec/metamodel/attr.json server/typescript/packages/metadata/src/core/attr/meta-attr-int-map.ts server/typescript/packages/metadata/src/core/attr/attr-constants.ts server/typescript/packages/metadata/src/core-types.ts server/typescript/packages/metadata/src/core/attr/attr-definition.embedded.ts server/typescript/packages/metadata/test/core/attr/meta-attr-int-map.test.ts
git commit -m "feat(metadata): add attr.intMap — a generic object-with-integer-values attr subtype"
```

---

### Task 2: TypeScript — `field.enum`'s `@intValueMap` attribute

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/field/field-constants.ts`
- Modify: `spec/metamodel/field.json`
- Modify: `server/typescript/packages/metadata/src/attr-schema-validate.ts`
- Test: `server/typescript/packages/metadata/test/attr-schema-validate-enum-intvaluemap.test.ts`

**Interfaces:**
- Consumes: `ATTR_SUBTYPE_INT_MAP` (Task 1).
- Produces: `FIELD_ATTR_INT_VALUE_MAP = "intValueMap"` — consumed by every later port task and by the persistence follow-on plans.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/typescript/packages/metadata/test/attr-schema-validate-enum-intvaluemap.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader.js";
import { InMemoryStringSource } from "../src/sources/in-memory-string-source.js";

async function load(json: string) {
  const loader = new MetaDataLoader();
  return loader.load([new InMemoryStringSource(json, "test.json")]);
}

const base = (extra: string) => `{
  "metadata.root": { "package": "acme", "children": [
    { "object.entity": { "name": "Order", "children": [
      { "field.long": { "name": "id" } },
      { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] ${extra} } },
      { "identity.primary": { "name": "pk", "@fields": ["id"] } }
    ]}}
  ]}
}`;

describe("field.enum @intValueMap content rules", () => {
  test("accepts a valid map — key set matches @values, unique ints", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}'));
    expect(result.errors).toEqual([]);
  });

  test("field.enum with no @intValueMap is still valid (string-backed default)", async () => {
    const result = await load(base(""));
    expect(result.errors).toEqual([]);
  });

  test("rejects a missing member key", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.code).toBe("ERR_BAD_ATTR_VALUE");
    expect(result.errors[0]?.message).toContain("ARCHIVED");
  });

  test("rejects an extra key not in @values", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9, "RETRACTED": 12}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.code).toBe("ERR_BAD_ATTR_VALUE");
    expect(result.errors[0]?.message).toContain("RETRACTED");
  });

  test("rejects a non-integer value", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": "zero", "PUBLISHED": 5, "ARCHIVED": 9}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.code).toBe("ERR_BAD_ATTR_VALUE");
  });

  test("rejects two members sharing the same int", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 0, "ARCHIVED": 9}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.code).toBe("ERR_BAD_ATTR_VALUE");
    expect(result.errors[0]?.message).toContain("DRAFT");
    expect(result.errors[0]?.message).toContain("PUBLISHED");
  });
});
```

> Adjust the exact `MetaDataLoader`/`InMemoryStringSource` import paths and the shape of `result.errors` (some loader APIs throw on the first error rather than returning an array) to match this package's actual loader test harness — check an existing test like `test/attr-schema-validate.test.ts` or `enum-inline`'s consuming test for the established pattern before finalizing this step.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/typescript && bun test packages/metadata/test/attr-schema-validate-enum-intvaluemap.test.ts`
Expected: FAIL — the "accepts a valid map" test fails with `ERR_UNKNOWN_ATTR` (strict provenance, Task 1 registered the generic subtype but `field.enum` doesn't yet accept `@intValueMap`).

- [ ] **Step 3: Add `FIELD_ATTR_INT_VALUE_MAP` constant**

Edit `server/typescript/packages/metadata/src/core/field/field-constants.ts` — add after `FIELD_ATTR_VALUES` (line 160), inside the existing "Enum attrs" section (line 155-157):

```typescript
/** Member symbols of an enum-subtype field. Required, string array. */
export const FIELD_ATTR_VALUES = "values";

/**
 * Optional per-member explicit integer value ({memberSymbol: int}) switching
 * this enum field's DB persistence from string+CHECK to integer+CHECK. Keys
 * must exactly match @values; values must be unique integers. The generated
 * native type and wire format are UNCHANGED in every language — this is a
 * persistence-layer-only concern (docs/superpowers/specs/2026-07-23-int-backed-
 * enum-values-design.md).
 */
export const FIELD_ATTR_INT_VALUE_MAP = "intValueMap";
```

- [ ] **Step 4: Add the attr declaration to the canonical field spec**

Edit `spec/metamodel/field.json` — add as a sibling of `values`/`provided` inside `field.enum`'s `children` array:

```json
        { "type": "attr", "subType": "intMap", "name": "intValueMap", "min": 0, "max": 1, "description": "Optional per-member int values ({member: int}) switching this enum field's DB persistence from string+CHECK to integer+CHECK. Keys must exactly match @values; values must be unique integers. The generated native type and wire format are unchanged in every language." }
```

- [ ] **Step 5: Regenerate the embedded field definition**

Run: `cd <repo-root> && bun scripts/generate-embedded-metamodel.ts`
Expected: regenerates `field-definition.embedded.ts`.

- [ ] **Step 6: Run tests again — confirm the ERR_UNKNOWN_ATTR failure is gone, new failures are the content-rule assertions**

Run: `cd server/typescript && bun test packages/metadata/test/attr-schema-validate-enum-intvaluemap.test.ts`
Expected: "accepts a valid map" and "no @intValueMap" pass; the four negative tests FAIL (no content-rule validation exists yet, so `result.errors` is empty when it should have entries).

- [ ] **Step 7: Add the content-rule validation**

Edit `server/typescript/packages/metadata/src/attr-schema-validate.ts` — add immediately after Check 5 (FR-011, ends around line 372), inside the same `if (node.type === TYPE_FIELD && node.subType === FIELD_SUBTYPE_ENUM)` gate:

```typescript
    // --- Check 5b: field.enum @intValueMap content rules ---
    //
    // Optional. Own-only (mirrors Checks 4/5's own-attrs-only policy) — an
    // inherited @intValueMap is validated on its declaring node. The generic
    // "is this an object of integers" shape check already ran via IntMapAttr
    // (attr subtype `intMap`); this validates the field.enum-SPECIFIC
    // semantics: key-set-equals-@values, and no two members share a value.
    const rawIntValueMap = node.ownAttrs().get(FIELD_ATTR_INT_VALUE_MAP);
    if (rawIntValueMap !== undefined && typeof rawIntValueMap === "object" && rawIntValueMap !== null) {
      const map = rawIntValueMap as Record<string, number>;
      const effectiveValues = node.attrs().get(FIELD_ATTR_VALUES);
      const declaredMembers: string[] = Array.isArray(effectiveValues) ? effectiveValues : [];
      const memberSet = new Set(declaredMembers);
      const mapKeys = Object.keys(map);
      const keySet = new Set(mapKeys);

      const missing = declaredMembers.filter((m) => !keySet.has(m));
      const extra = mapKeys.filter((k) => !memberSet.has(k));
      if (missing.length > 0 || extra.length > 0) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} attribute '@${FIELD_ATTR_INT_VALUE_MAP}' keys must exactly match '@${FIELD_ATTR_VALUES}' members` +
              (missing.length > 0 ? ` (missing: ${missing.join(", ")})` : "") +
              (extra.length > 0 ? ` (unknown: ${extra.join(", ")})` : "") + ".",
            { code: "ERR_BAD_ATTR_VALUE", source: node.source },
          ),
        );
      }

      const seenValues = new Map<number, string>();
      for (const [member, value] of Object.entries(map)) {
        if (typeof value !== "number" || !Number.isInteger(value)) continue; // IntMapAttr already reported this
        const owner = seenValues.get(value);
        if (owner !== undefined) {
          errors.push(
            new ParseError(
              `${nodeLabel(node)} attribute '@${FIELD_ATTR_INT_VALUE_MAP}' members '${owner}' and '${member}' ` +
                `share the same value ${value}; every member must have a unique int.`,
              { code: "ERR_BAD_ATTR_VALUE", source: node.source },
            ),
          );
        } else {
          seenValues.set(value, member);
        }
      }
    }
```

Add `FIELD_ATTR_INT_VALUE_MAP` to this file's existing import block from `@metaobjectsdev/metadata`'s field-constants (or the local relative import this file already uses for `FIELD_ATTR_VALUES` — match its existing import style).

- [ ] **Step 8: Run tests — confirm all pass**

Run: `cd server/typescript && bun test packages/metadata/test/attr-schema-validate-enum-intvaluemap.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 9: Run the full metadata test suite**

Run: `cd server/typescript && bun test packages/metadata`
Expected: all pass, no regressions.

- [ ] **Step 10: Commit**

```bash
git add server/typescript/packages/metadata/src/core/field/field-constants.ts spec/metamodel/field.json server/typescript/packages/metadata/src/core/field/field-definition.embedded.ts server/typescript/packages/metadata/src/attr-schema-validate.ts server/typescript/packages/metadata/test/attr-schema-validate-enum-intvaluemap.test.ts
git commit -m "feat(metadata): field.enum @intValueMap — explicit per-member int values for DB persistence"
```

---

### Task 3: Shared conformance fixtures (`fixtures/conformance/`)

**Files:**
- Create: `fixtures/conformance/enum-int-backed/input/meta.enums.json`
- Create: `fixtures/conformance/enum-int-backed/expected.json`
- Create: `fixtures/conformance/enum-int-backed-array/input/meta.enums.json`
- Create: `fixtures/conformance/enum-int-backed-array/expected.json`
- Create: `fixtures/conformance/error-enum-intvaluemap-key-mismatch/input/meta.enums.json`
- Create: `fixtures/conformance/error-enum-intvaluemap-key-mismatch/expected.json`
- Create: `fixtures/conformance/error-enum-intvaluemap-non-int/input/meta.enums.json`
- Create: `fixtures/conformance/error-enum-intvaluemap-non-int/expected.json`
- Create: `fixtures/conformance/error-enum-intvaluemap-duplicate-value/input/meta.enums.json`
- Create: `fixtures/conformance/error-enum-intvaluemap-duplicate-value/expected.json`

**Interfaces:**
- Consumes: `@intValueMap` (Task 2), plus this repo's existing conformance fixture format (see `fixtures/conformance/enum-inline/` for the reference shape).
- Produces: five fixtures every port's own conformance test runner discovers and asserts against (Tasks 5, 7, 9, 11).

- [ ] **Step 1: Create `enum-int-backed` (positive)**

`fixtures/conformance/enum-int-backed/input/meta.enums.json`:
```json
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
    { "identity.primary": { "name": "id", "@fields": "id" } }
  ]}}
]}}
```

`fixtures/conformance/enum-int-backed/expected.json` (the same document with shorthand `@fields` expanded to an array, matching how `enum-inline/expected.json` normalizes it — verify the exact expansion by diffing against `enum-inline/expected.json`'s own `@fields` line before finalizing):
```json
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
    { "identity.primary": { "name": "id", "@fields": ["id"] } }
  ]}}
]}}
```

- [ ] **Step 2: Create `enum-int-backed-array` (positive, array-of-enum)**

`fixtures/conformance/enum-int-backed-array/input/meta.enums.json`:
```json
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Ticket", "children": [
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "labels", "isArray": true, "@values": ["LOW","MEDIUM","HIGH"], "@intValueMap": { "LOW": 1, "MEDIUM": 2, "HIGH": 3 } } },
    { "identity.primary": { "name": "id", "@fields": "id" } }
  ]}}
]}}
```

`fixtures/conformance/enum-int-backed-array/expected.json` — same document with `@fields` expanded (mirror Step 1's normalization).

- [ ] **Step 3: Create `error-enum-intvaluemap-key-mismatch` (negative)**

`fixtures/conformance/error-enum-intvaluemap-key-mismatch/input/meta.enums.json`:
```json
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5 } } },
    { "identity.primary": { "name": "id", "@fields": "id" } }
  ]}}
]}}
```

`fixtures/conformance/error-enum-intvaluemap-key-mismatch/expected.json` — match the negative-fixture format used by `error-enum-empty-values/expected.json` (an error-code envelope, not a normalized document — read that file first and mirror its exact shape):
```json
{ "errors": [ { "code": "ERR_BAD_ATTR_VALUE" } ] }
```

- [ ] **Step 4: Create `error-enum-intvaluemap-non-int` (negative)**

`fixtures/conformance/error-enum-intvaluemap-non-int/input/meta.enums.json`:
```json
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"], "@intValueMap": { "DRAFT": "zero", "PUBLISHED": 5 } } },
    { "identity.primary": { "name": "id", "@fields": "id" } }
  ]}}
]}}
```

`expected.json`: `{ "errors": [ { "code": "ERR_BAD_ATTR_VALUE" } ] }`

- [ ] **Step 5: Create `error-enum-intvaluemap-duplicate-value` (negative)**

`fixtures/conformance/error-enum-intvaluemap-duplicate-value/input/meta.enums.json`:
```json
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "field.long": { "name": "id" } },
    { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 0 } } },
    { "identity.primary": { "name": "id", "@fields": "id" } }
  ]}}
]}}
```

`expected.json`: `{ "errors": [ { "code": "ERR_BAD_ATTR_VALUE" } ] }`

- [ ] **Step 6: Run TS's conformance fixture runner to sanity-check the fixtures parse (does not yet confirm cross-port correctness — that's Tasks 5/7/9/11)**

Run: `cd server/typescript && bun test packages/metadata -t conformance`
Expected: the two new positive fixtures pass; the three negative fixtures pass (each correctly produces exactly the expected error code) — since Task 2 already implemented the validation, all five should be green already at this step.

- [ ] **Step 7: Commit**

```bash
git add fixtures/conformance/enum-int-backed fixtures/conformance/enum-int-backed-array fixtures/conformance/error-enum-intvaluemap-key-mismatch fixtures/conformance/error-enum-intvaluemap-non-int fixtures/conformance/error-enum-intvaluemap-duplicate-value
git commit -m "test(conformance): add cross-port fixtures for field.enum @intValueMap"
```

---

### Task 4: Shared — `registry-conformance/expected-registry.json`

**Files:**
- Modify: `fixtures/registry-conformance/expected-registry.json`

**Interfaces:**
- Consumes: Tasks 1-2's TS registration (the manifest is generated from TS's live registry and hand-verified, then used as the golden file every port compares against).

- [ ] **Step 1: Add the new `attr.intMap` type entry**

Edit `fixtures/registry-conformance/expected-registry.json` — insert alphabetically between the `int` (ends line 52) and `long` (starts line 53) attr type blocks:

```json
    {
      "type": "attr",
      "subType": "intMap",
      "description": "An object-shaped attribute whose values are all integers (e.g. field.enum's @intValueMap: {memberSymbol: int}). Generic shape check only; a consumer field type layers its own semantic rules (key-set membership, uniqueness) in its own content-rule validation.",
      "attrs": [],
      "children": []
    },
```

- [ ] **Step 2: Add the `intValueMap` attr entry to `field.enum`'s `attrs` array**

Edit the same file — inside the `field`/`enum` block (starts line 929), insert alphabetically among the existing `attrs` entries (after `formExclude`, before whatever sorts after `intValueMap` alphabetically — read the surrounding entries first to place it exactly):

```json
        {
          "name": "intValueMap",
          "valueType": "intMap",
          "isArray": false,
          "required": false,
          "description": "Optional per-member int values ({member: int}) switching this enum field's DB persistence from string+CHECK to integer+CHECK. Keys must exactly match @values; values must be unique integers. The generated native type and wire format are unchanged in every language."
        },
```

- [ ] **Step 3: Run TS's registry-conformance test to confirm the manifest now matches TS's live registry**

Run: `cd server/typescript && bun test packages/metadata -t registry-conformance`
Expected: PASS. If it fails on an unrelated diff (ordering, wording), adjust this file's new entries — not TS's source — to match, since this file must byte-match whatever TS's registry generator actually emits.

- [ ] **Step 4: Commit**

```bash
git add fixtures/registry-conformance/expected-registry.json
git commit -m "test(registry-conformance): register field.enum @intValueMap (attr.intMap)"
```

---

### Task 5: TypeScript — full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full TS metadata suite**

Run: `cd server/typescript && bun test packages/metadata`
Expected: 100% pass, zero regressions.

- [ ] **Step 2: Run the full server TS suite as a broader regression check**

Run: `cd server/typescript && bun test`
Expected: 100% pass (this also exercises `codegen-ts` and `migrate-ts`, which per this plan's scope should show ZERO behavior change — if any codegen or migrate-ts test changes behavior here, that's a signal `@intValueMap` leaked into a place it shouldn't have at this stage; investigate before proceeding).

- [ ] **Step 3: Typecheck**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/metadata' typecheck`
Expected: no new errors introduced by this plan's changes (pre-existing unrelated errors, if any, are out of scope).

---

### Task 6: C# — `attr.intMap` subtype + `field.enum`'s `@intValueMap`

**Files:**
- Modify: `server/csharp/MetaObjects/Core/Attr/AttrConstants.cs`
- Modify: `server/csharp/MetaObjects/CoreTypes.cs`
- Modify: `server/csharp/MetaObjects/Core/Field/FieldConstants.cs`
- Modify: `server/csharp/MetaObjects/Core/Field/FieldSchema.cs`
- Modify: `server/csharp/MetaObjects/Loader/ValidationPasses.cs`
- Modify: `server/csharp/MetaObjects/SpecMetamodel/attr.json`
- Modify: `server/csharp/MetaObjects/SpecMetamodel/field.json`
- Test: `server/csharp/MetaObjects.Tests/EnumIntValueMapTests.cs`

**Interfaces:**
- Produces: `FieldConstants.FIELD_ATTR_INT_VALUE_MAP`, `AttrConstants.ATTR_SUBTYPE_INT_MAP` — no other task in this plan consumes them, but the C# persistence follow-on plan will.

- [ ] **Step 1: Write the failing tests**

```csharp
// server/csharp/MetaObjects.Tests/EnumIntValueMapTests.cs
using Xunit;
using MetaObjects.Loader;

namespace MetaObjects.Tests;

public class EnumIntValueMapTests
{
    private static string Model(string extra) => $$"""
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] {{extra}} } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}
    """;

    private static (bool Ok, System.Collections.Generic.IReadOnlyList<MetaError> Errors) TryLoad(string json)
    {
        var loader = new MetaDataLoader();
        var source = new InMemoryStringSource(json, "test.json");
        var result = loader.Load(new[] { (IMetaDataSource)source });
        return (result.Errors.Count == 0, result.Errors);
    }

    [Fact]
    public void Valid_intValueMap_with_matching_keys_and_unique_ints_loads_clean()
    {
        var (ok, errors) = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}"""));
        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void No_intValueMap_still_loads_clean_string_backed_default()
    {
        var (ok, _) = TryLoad(Model(""));
        Assert.True(ok);
    }

    [Fact]
    public void Missing_member_key_is_rejected()
    {
        var (ok, errors) = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5}"""));
        Assert.False(ok);
        Assert.Contains(errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("ARCHIVED"));
    }

    [Fact]
    public void Extra_key_not_in_values_is_rejected()
    {
        var (ok, errors) = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9, "RETRACTED": 12}"""));
        Assert.False(ok);
        Assert.Contains(errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("RETRACTED"));
    }

    [Fact]
    public void Non_integer_value_is_rejected()
    {
        var (ok, errors) = TryLoad(Model(""", "@intValueMap": {"DRAFT": "zero", "PUBLISHED": 5, "ARCHIVED": 9}"""));
        Assert.False(ok);
        Assert.Contains(errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Duplicate_int_value_across_members_is_rejected()
    {
        var (ok, errors) = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 0, "ARCHIVED": 9}"""));
        Assert.False(ok);
        Assert.Contains(errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE
            && e.Message.Contains("DRAFT") && e.Message.Contains("PUBLISHED"));
    }
}
```

> Adjust `InMemoryStringSource`/`MetaDataLoader.Load` call shape and the `Errors`/`MetaError` field names to match this codebase's actual API (check an existing test in `MetaObjects.Tests` that loads inline JSON and asserts on errors, e.g. a test near `EnumFieldTest`-equivalent, before finalizing).

- [ ] **Step 2: Run to verify failure**

Run: `cd server/csharp && dotnet test MetaObjects.Tests --filter EnumIntValueMapTests`
Expected: FAIL — `ERR_UNKNOWN_ATTR` on the positive test (attr not yet registered).

- [ ] **Step 3: Add `ATTR_SUBTYPE_INT_MAP` constant**

Edit `server/csharp/MetaObjects/Core/Attr/AttrConstants.cs` — add next to `ATTR_SUBTYPE_PROPERTIES` (around line 22) and into its subtype list (around line 47):

```csharp
public const string ATTR_SUBTYPE_INT_MAP = "intMap";
```

- [ ] **Step 4: Register the `DataType.Object` dispatch entry**

Edit `server/csharp/MetaObjects/CoreTypes.cs` — add to the dispatch table shown at lines 125-137:

```csharp
        [ATTR_SUBTYPE_PROPERTIES]    = DataType.Object,
        [ATTR_SUBTYPE_INT_MAP]       = DataType.Object,
```

- [ ] **Step 5: Add `FIELD_ATTR_INT_VALUE_MAP` constant**

Edit `server/csharp/MetaObjects/Core/Field/FieldConstants.cs` — add next to `FIELD_ATTR_VALUES` (around line 184):

```csharp
public const string FIELD_ATTR_INT_VALUE_MAP = "intValueMap";
```

- [ ] **Step 6: Add the `IntValueMapAttr` schema entry**

Edit `server/csharp/MetaObjects/Core/Field/FieldSchema.cs` — add next to `EnumValuesAttr` (around line 168):

```csharp
    /// <summary>The @intValueMap attr — only on field.enum. Optional object of integers.</summary>
    public static readonly AttrSchema IntValueMapAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_INT_VALUE_MAP,
        ValueType: AttrConstants.ATTR_SUBTYPE_INT_MAP,
        Required: false,
        Description: "Optional per-member int values ({member: int}) switching this enum field's DB persistence from string+CHECK to integer+CHECK. Keys must exactly match @values; values must be unique integers.");
```

- [ ] **Step 7: Register the attr on the `enum` subtype**

Edit `server/csharp/MetaObjects/CoreTypes.cs` at the line found in research (`FIELD_SUBTYPE_ENUM => [.. FieldSchema.CommonFieldAttrs, FieldSchema.EnumValuesAttr, FieldSchema.ProvidedAttr]`, around line 304):

```csharp
FIELD_SUBTYPE_ENUM => [.. FieldSchema.CommonFieldAttrs, FieldSchema.EnumValuesAttr, FieldSchema.ProvidedAttr, FieldSchema.IntValueMapAttr],
```

- [ ] **Step 8: Add the content-rule validation to Pass 10**

Edit `server/csharp/MetaObjects/Loader/ValidationPasses.cs` — inside `WalkEnumValues`, after the existing Rule 4 (FR-011 fallback-attr check, ends before the closing brace shown in research), add:

```csharp
            // Rule 5: @intValueMap content rules (optional).
            //   a. Key set must exactly match @values.
            //   b. No two members may share the same int (protobuf's stance — no alias opt-in).
            //   (Every-value-is-an-integer is already enforced by the generic
            //   ATTR_SUBTYPE_INT_MAP dispatch/JSON-type check at parse time.)
            if (field.OwnAttr(FIELD_ATTR_INT_VALUE_MAP) is System.Collections.IDictionary intValueMap)
            {
                var effective = field.EffectiveEnumValues ?? new List<string>();
                var memberSet = new HashSet<string>(effective, StringComparer.Ordinal);
                var mapKeys = new List<string>();
                foreach (var key in intValueMap.Keys) mapKeys.Add((string)key);
                var keySet = new HashSet<string>(mapKeys, StringComparer.Ordinal);

                var missing = effective.Where(m => !keySet.Contains(m)).ToList();
                var extra = mapKeys.Where(k => !memberSet.Contains(k)).ToList();
                if (missing.Count > 0 || extra.Count > 0)
                {
                    errors.Add(new MetaError(
                        $"field.enum '{field.Name}' attribute '@{FIELD_ATTR_INT_VALUE_MAP}' keys must exactly match '@{FIELD_ATTR_VALUES}' members" +
                        (missing.Count > 0 ? $" (missing: {string.Join(", ", missing)})" : "") +
                        (extra.Count > 0 ? $" (unknown: {string.Join(", ", extra)})" : "") + ".",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        Envelope: field.Source));
                }

                var seenValues = new Dictionary<long, string>();
                foreach (var key in mapKeys)
                {
                    if (intValueMap[key] is not long and not int) continue; // generic dispatch already reported this
                    var value = System.Convert.ToInt64(intValueMap[key]);
                    if (seenValues.TryGetValue(value, out var owner))
                    {
                        errors.Add(new MetaError(
                            $"field.enum '{field.Name}' attribute '@{FIELD_ATTR_INT_VALUE_MAP}' members '{owner}' and '{key}' " +
                            $"share the same value {value}; every member must have a unique int.",
                            ErrorCode.ERR_BAD_ATTR_VALUE,
                            Envelope: field.Source));
                    }
                    else
                    {
                        seenValues[value] = key;
                    }
                }
            }
```

> The exact C# type `OwnAttr` returns for an object-shaped attr value (`IDictionary`, `JsonObject`, or a custom `Dictionary<string, object>`) depends on this codebase's JSON-parsing layer — check how the existing `@enumAlias`/`@enumDoc`-style properties attrs are read elsewhere in this file (or in `SpringDtoGenerator`-equivalent C# consumers) and match that exact type before finalizing this step.

- [ ] **Step 9: Add the `attr.intMap` and `field.enum.intValueMap` declarations to C#'s spec copies**

Edit `server/csharp/MetaObjects/SpecMetamodel/attr.json` and `server/csharp/MetaObjects/SpecMetamodel/field.json` with the same two JSON snippets used in TS Task 1 Step 6 and Task 2 Step 4 (these are C#'s own packaged copies — keep them semantically identical to the canonical `spec/metamodel/*.json`, per this plan's Global Constraints; there is no automated drift-gate tying them together today, so this is a manual-fidelity step, not a generated one).

- [ ] **Step 10: Run tests — confirm all pass**

Run: `cd server/csharp && dotnet test MetaObjects.Tests --filter EnumIntValueMapTests`
Expected: PASS — all 6 tests green.

- [ ] **Step 11: Run the full C# metadata test suite**

Run: `cd server/csharp && dotnet test MetaObjects.Tests`
Expected: all pass, no regressions.

- [ ] **Step 12: Commit**

```bash
git add server/csharp/MetaObjects/Core/Attr/AttrConstants.cs server/csharp/MetaObjects/CoreTypes.cs server/csharp/MetaObjects/Core/Field/FieldConstants.cs server/csharp/MetaObjects/Core/Field/FieldSchema.cs server/csharp/MetaObjects/Loader/ValidationPasses.cs server/csharp/MetaObjects/SpecMetamodel/attr.json server/csharp/MetaObjects/SpecMetamodel/field.json server/csharp/MetaObjects.Tests/EnumIntValueMapTests.cs
git commit -m "feat(csharp): field.enum @intValueMap — explicit per-member int values for DB persistence"
```

---

### Task 7: C# — full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the shared conformance fixtures against C#'s loader**

Run: `cd server/csharp && dotnet test MetaObjects.Tests --filter ConformanceTests` (adjust the filter name to whatever test class discovers/runs `fixtures/conformance/*` — check for a `ConformanceRunner`-style test class first)
Expected: the five fixtures from Task 3 all pass.

- [ ] **Step 2: Run C#'s registry-conformance test**

Run: `cd server/csharp && dotnet test MetaObjects.Tests --filter RegistryConformance`
Expected: PASS against the `expected-registry.json` Task 4 updated.

- [ ] **Step 3: Run the full C# test suite**

Run: `cd server/csharp && dotnet test`
Expected: 100% pass, no regressions, including `MetaObjects.Codegen.Tests` (should show zero behavior change — codegen isn't touched by this plan).

---

### Task 8: Java (+ Kotlin) — `attr.intMap` subtype + `field.enum`'s `@intValueMap`

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/attr/IntMapAttribute.java`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/field/EnumField.java`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/field/EnumFieldIntValueMapTest.java`

**Interfaces:**
- Produces: `EnumField.ATTR_INT_VALUE_MAP`, `IntMapAttribute.SUBTYPE_INT_MAP` — consumed by the Java+Kotlin persistence follow-on plan.

**Note:** Do NOT register `@intValueMap` using the existing `PropertiesAttribute` class. It is backed by `java.util.Properties`, confirmed (`PropertiesAttribute.java:51-60`) to coerce every value to `String` on load — silently turning `0` into `"0"`. Since canonical-JSON round-trip serialization must stay byte-identical with TS/C#/Python (which preserve real integers), Java needs its own `Map<String,Integer>`-backed class, mirroring `PropertiesAttribute`'s structure exactly but preserving int fidelity on both parse and `getValueAsString()`.

- [ ] **Step 1: Write the failing test**

```java
// server/java/metadata/src/test/java/com/metaobjects/field/EnumFieldIntValueMapTest.java
package com.metaobjects.field;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.source.InMemoryMetaDataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class EnumFieldIntValueMapTest {

    private static String model(String extra) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "{ \"object.entity\": { \"name\": \"Order\", \"children\": [" +
            "{ \"field.long\": { \"name\": \"id\" } }," +
            "{ \"field.enum\": { \"name\": \"status\", \"@values\": [\"DRAFT\",\"PUBLISHED\",\"ARCHIVED\"]" + extra + " } }," +
            "{ \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } }" +
            "]}}]}}";
    }

    private static MetaDataException loadExpectingError(String json) {
        var loader = new MetaDataLoader();
        return assertThrows(MetaDataException.class, () ->
            loader.load(java.util.List.of(new InMemoryMetaDataSource(json, "test.json"))));
    }

    @Test
    void validIntValueMapWithMatchingKeysAndUniqueIntsLoadsClean() {
        var loader = new MetaDataLoader();
        assertDoesNotThrow(() -> loader.load(java.util.List.of(new InMemoryMetaDataSource(
            model(", \"@intValueMap\": {\"DRAFT\": 0, \"PUBLISHED\": 5, \"ARCHIVED\": 9}"), "test.json"))));
    }

    @Test
    void noIntValueMapStillLoadsCleanStringBackedDefault() {
        var loader = new MetaDataLoader();
        assertDoesNotThrow(() -> loader.load(java.util.List.of(new InMemoryMetaDataSource(model(""), "test.json"))));
    }

    @Test
    void missingMemberKeyIsRejected() {
        var ex = loadExpectingError(model(", \"@intValueMap\": {\"DRAFT\": 0, \"PUBLISHED\": 5}"));
        assertEquals(com.metaobjects.ErrorCode.ERR_BAD_ATTR_VALUE, ex.getErrorCode());
        assertTrue(ex.getMessage().contains("ARCHIVED"));
    }

    @Test
    void extraKeyNotInValuesIsRejected() {
        var ex = loadExpectingError(model(", \"@intValueMap\": {\"DRAFT\": 0, \"PUBLISHED\": 5, \"ARCHIVED\": 9, \"RETRACTED\": 12}"));
        assertEquals(com.metaobjects.ErrorCode.ERR_BAD_ATTR_VALUE, ex.getErrorCode());
        assertTrue(ex.getMessage().contains("RETRACTED"));
    }

    @Test
    void nonIntegerValueIsRejected() {
        var ex = loadExpectingError(model(", \"@intValueMap\": {\"DRAFT\": \"zero\", \"PUBLISHED\": 5, \"ARCHIVED\": 9}"));
        assertEquals(com.metaobjects.ErrorCode.ERR_BAD_ATTR_VALUE, ex.getErrorCode());
    }

    @Test
    void duplicateIntValueAcrossMembersIsRejected() {
        var ex = loadExpectingError(model(", \"@intValueMap\": {\"DRAFT\": 0, \"PUBLISHED\": 0, \"ARCHIVED\": 9}"));
        assertEquals(com.metaobjects.ErrorCode.ERR_BAD_ATTR_VALUE, ex.getErrorCode());
        assertTrue(ex.getMessage().contains("DRAFT") && ex.getMessage().contains("PUBLISHED"));
    }
}
```

> Check this module's actual in-memory-source test helper name/package (`InMemoryMetaDataSource` is a placeholder guess) and the loader's actual single-error-throw-vs-collect behavior against an existing test like `EnumFieldTest.java` before finalizing — mirror its exact loading idiom.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/java && mvn -pl metadata test -Dtest=EnumFieldIntValueMapTest`
Expected: FAIL — `ERR_UNKNOWN_ATTR` on the positive tests.

- [ ] **Step 3: Write `IntMapAttribute.java`**

```java
package com.metaobjects.attr;

import com.metaobjects.DataTypes;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * An object-shaped attribute whose values are all integers (e.g. field.enum's
 * {@code @intValueMap}: {member: int}). Mirrors {@link PropertiesAttribute}'s
 * structure, but backed by {@code Map<String, Integer>} rather than
 * {@code java.util.Properties} — Properties forces every value to a String on
 * load, which would silently corrupt int fidelity on canonical-JSON round-trip.
 * Generic shape check only (object, every value an integer); a consumer field
 * type (field.enum) layers its own semantic rules (key-set membership,
 * uniqueness) in its own post-load content-rule validation.
 */
public class IntMapAttribute extends MetaAttribute<Map<String, Integer>> {

    public static final String SUBTYPE_INT_MAP = "intMap";

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(IntMapAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_INT_MAP)
            .description("An object-shaped attribute whose values are all integers.")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );
    }

    public IntMapAttribute(String name) {
        super(SUBTYPE_INT_MAP, name, DataTypes.CUSTOM);
    }

    public static IntMapAttribute create(String name, Map<String, Integer> value) {
        IntMapAttribute a = new IntMapAttribute(name);
        a.setValue(value);
        return a;
    }

    @Override
    public void setValueAsObject(Object value) {
        if (value == null) {
            setValue(null);
        } else if (value instanceof String) {
            setValueAsString((String) value);
        } else if (value instanceof Map) {
            Map<String, Integer> m = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                m.put(e.getKey().toString(), coerceInt(e.getValue()));
            }
            setValue(m);
        } else {
            throw new InvalidAttributeValueException(
                "Can not set value with class [" + value.getClass() + "] for object: " + value);
        }
    }

    @Override
    public void setValueAsString(String value) {
        if (value == null) { setValue(null); return; }
        String trimmed = value.trim();
        if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
            throw new InvalidAttributeValueException(
                "Could not parse intMap attribute value (expected a JSON object): " + value);
        }
        com.google.gson.JsonObject obj = com.google.gson.JsonParser.parseString(trimmed).getAsJsonObject();
        Map<String, Integer> m = new LinkedHashMap<>();
        for (Map.Entry<String, com.google.gson.JsonElement> e : obj.entrySet()) {
            com.google.gson.JsonElement el = e.getValue();
            if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()) {
                m.put(e.getKey(), el.getAsInt());
            } else {
                // Not a number — record a sentinel that fails the generic content
                // check downstream (own validateEnumNode reports the specific error);
                // we don't throw here so the loader can report ALL bad members, not
                // just the first, matching the other ports' collect-not-throw style
                // at the field-content-rule layer. Store Integer.MIN_VALUE as a
                // deliberately-invalid marker is avoided — instead we fail loudly here,
                // since this attribute type's OWN contract is "every value is an int".
                throw new InvalidAttributeValueException(
                    "attribute '@" + getName() + "' member '" + e.getKey() + "' has value '" + el +
                    "' which is not an integer");
            }
        }
        setValue(m);
    }

    private static int coerceInt(Object value) {
        if (value instanceof Integer i) return i;
        if (value instanceof Number n && n.doubleValue() == Math.floor(n.doubleValue())) return n.intValue();
        throw new InvalidAttributeValueException("intMap value is not an integer: " + value);
    }

    @Override
    public String getValueAsString() {
        return getValue() == null ? null : new com.google.gson.Gson().toJson(getValue());
    }
}
```

> `EnumFieldIntValueMapTest`'s `nonIntegerValueIsRejected` test expects `ERR_BAD_ATTR_VALUE`, but this class throws `InvalidAttributeValueException` directly — check how `InvalidAttributeValueException` maps to `ErrorCode.ERR_BAD_ATTR_VALUE` elsewhere in the loader (likely a catch-and-wrap in `MetaDataLoader`/`ValidationPhase`) before finalizing; if it doesn't already map that way, catch it at the `field.enum` content-rule layer (`EnumField`/`ValidationPhase`) instead of letting it escape raw.

- [ ] **Step 4: Register `IntMapAttribute` in the metadata provider bootstrap**

Find wherever `PropertiesAttribute.registerTypes(registry)` is called (search `FieldTypesMetaDataProvider.java` or the equivalent core-attrs provider file — the same place Task 8's research found `EnumField.registerTypes(registry)` wired at `FieldTypesMetaDataProvider.java:66`) and add a sibling call:

```java
IntMapAttribute.registerTypes(registry);
```

- [ ] **Step 5: Add `ATTR_INT_VALUE_MAP` constant to `EnumField.java`**

Edit `server/java/metadata/src/main/java/com/metaobjects/field/EnumField.java` — add next to `ATTR_VALUES` (around line 60):

```java
    /**
     * Name of the optional per-member explicit-integer-value attribute
     * ({@code {member: int}}), switching this enum field's DB persistence from
     * string+CHECK to integer+CHECK. Keys must exactly match {@code @values};
     * values must be unique integers. Cross-language vocabulary:
     * {@code @intValueMap} in canonical JSON.
     */
    public static final String ATTR_INT_VALUE_MAP = "intValueMap";
```

- [ ] **Step 6: Register the attr in `EnumField.registerTypes`**

Edit the same file's `registerTypes` method (shown in research at line 173-221) — add after the `ATTR_PROVIDED` registration:

```java
                // Optional @intValueMap — an object-shaped attribute whose values
                // are all integers. Key-set-matches-@values and uniqueness are
                // validated post-load in ValidationPhase (own-only, same as @values).
                def.optionalAttributeWithConstraints(ATTR_INT_VALUE_MAP)
                   .ofType(com.metaobjects.attr.IntMapAttribute.SUBTYPE_INT_MAP)
                   .asSingle();
```

- [ ] **Step 7: Add the content-rule validation to `ValidationPhase.java`**

Edit `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java` — inside `validateEnumNode` (shown in research at lines 503-538), add after the existing own-`@values` content check and before `validateEnumFr011Attrs(node)` is called:

```java
        // --- Own @intValueMap content check (optional) ---
        if (node.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP, false)) {
            @SuppressWarnings("unchecked")
            java.util.Map<String, Integer> intValueMap =
                (java.util.Map<String, Integer>) node.getMetaAttr(EnumField.ATTR_INT_VALUE_MAP, false).getValue();
            java.util.List<String> effective = effectiveEnumValues(node);
            java.util.Set<String> memberSet = new java.util.HashSet<>(effective);
            java.util.Set<String> keySet = intValueMap.keySet();

            java.util.List<String> missing = effective.stream().filter(m -> !keySet.contains(m)).toList();
            java.util.List<String> extra = keySet.stream().filter(k -> !memberSet.contains(k)).toList();
            if (!missing.isEmpty() || !extra.isEmpty()) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                        + ": field.enum '" + node.getName() + "' attribute '@" + EnumField.ATTR_INT_VALUE_MAP
                        + "' keys must exactly match '@" + EnumField.ATTR_VALUES + "' members"
                        + (missing.isEmpty() ? "" : " (missing: " + String.join(", ", missing) + ")")
                        + (extra.isEmpty() ? "" : " (unknown: " + String.join(", ", extra) + ")") + ".",
                    ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
            }

            java.util.Map<Integer, String> seenValues = new java.util.HashMap<>();
            for (var entry : intValueMap.entrySet()) {
                Integer value = entry.getValue();
                String owner = seenValues.putIfAbsent(value, entry.getKey());
                if (owner != null) {
                    throw new MetaDataException(
                        ErrorMessageConstants.ERR_BAD_ATTR_VALUE
                            + ": field.enum '" + node.getName() + "' attribute '@" + EnumField.ATTR_INT_VALUE_MAP
                            + "' members '" + owner + "' and '" + entry.getKey()
                            + "' share the same value " + value + "; every member must have a unique int.",
                        ErrorCode.ERR_BAD_ATTR_VALUE, node.getSource());
                }
            }
        }
```

> `effectiveEnumValues(node)` already exists per research (line 602-619) — confirm its exact return type (`List<String>`) matches this usage.

- [ ] **Step 8: Run tests — confirm all pass**

Run: `cd server/java && mvn -pl metadata test -Dtest=EnumFieldIntValueMapTest`
Expected: PASS — all 6 tests green.

- [ ] **Step 9: Run the full Java metadata module test suite**

Run: `cd server/java && mvn -pl metadata test`
Expected: all pass, no regressions.

- [ ] **Step 10: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/attr/IntMapAttribute.java server/java/metadata/src/main/java/com/metaobjects/field/EnumField.java server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java server/java/metadata/src/test/java/com/metaobjects/field/EnumFieldIntValueMapTest.java
git commit -m "feat(java): field.enum @intValueMap — explicit per-member int values for DB persistence"
```

---

### Task 9: Java (+ Kotlin) — full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the shared conformance fixtures against Java's loader**

Run: `cd server/java && mvn -pl metadata test -Dtest=*ConformanceTest*` (adjust to the actual test class that discovers `fixtures/conformance/*`)
Expected: the five fixtures from Task 3 all pass.

- [ ] **Step 2: Run Java's registry-conformance test**

Run: `cd server/java && mvn -pl metadata test -Dtest=*RegistryConformance*`
Expected: PASS against Task 4's updated `expected-registry.json`.

- [ ] **Step 3: Run the Kotlin module's tests to confirm no regression** (Kotlin shares Java's metadata layer — this is a smoke check, not new Kotlin-specific work)

Run: `cd server/java && mvn -pl codegen-kotlin,metadata-ktx test`
Expected: all pass, no regressions.

- [ ] **Step 4: Run the full Java build**

Run: `cd server/java && mvn test`
Expected: 100% pass (excluding any pre-existing known-red modules unrelated to this change).

---

### Task 10: Python — `attr.intMap` subtype + `field.enum`'s `@intValueMap`

**Files:**
- Modify: `server/python/src/metaobjects/meta/core/attr/attr_constants.py`
- Modify: `server/python/src/metaobjects/meta/core/attr/meta_attr.py`
- Modify: `server/python/src/metaobjects/spec_metamodel/attr.json`
- Modify: `server/python/src/metaobjects/spec_metamodel/field.json`
- Modify: `server/python/src/metaobjects/field_constants.py`
- Modify: `server/python/src/metaobjects/loader/validation_passes.py`
- Test: `server/python/tests/unit/test_field_enum_intvaluemap.py`

**Interfaces:**
- Produces: `FIELD_ATTR_INT_VALUE_MAP`, `ATTR_SUBTYPE_INT_MAP` — consumed by the Python persistence follow-on plan.

- [ ] **Step 1: Write the failing tests**

```python
# server/python/tests/unit/test_field_enum_intvaluemap.py
import pytest
from metaobjects.loader.loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.errors import ErrorCode, MetaDataException


def _model(extra: str) -> str:
    return f"""{{ "metadata.root": {{ "package": "acme", "children": [
      {{ "object.entity": {{ "name": "Order", "children": [
        {{ "field.long": {{ "name": "id" }} }},
        {{ "field.enum": {{ "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] {extra} }} }},
        {{ "identity.primary": {{ "name": "pk", "@fields": ["id"] }} }}
      ]}} }}
    ]}} }}"""


def _load(json_str: str):
    loader = MetaDataLoader()
    return loader.load([InMemoryStringSource(json_str, "test.json")])


def test_valid_intvaluemap_with_matching_keys_and_unique_ints_loads_clean():
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}'))
    assert result.errors == []


def test_no_intvaluemap_still_loads_clean_string_backed_default():
    result = _load(_model(""))
    assert result.errors == []


def test_missing_member_key_is_rejected():
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE
    assert "ARCHIVED" in result.errors[0].message


def test_extra_key_not_in_values_is_rejected():
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9, "RETRACTED": 12}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE
    assert "RETRACTED" in result.errors[0].message


def test_non_integer_value_is_rejected():
    result = _load(_model(', "@intValueMap": {"DRAFT": "zero", "PUBLISHED": 5, "ARCHIVED": 9}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE


def test_duplicate_int_value_across_members_is_rejected():
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 0, "ARCHIVED": 9}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE
    assert "DRAFT" in result.errors[0].message and "PUBLISHED" in result.errors[0].message
```

> Check `test_field_enum.py`'s actual `MetaDataLoader`/source-loading and `result.errors` shape (some Python loader paths raise `MetaDataException` on first error rather than collecting) before finalizing — mirror its established pattern exactly.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/python && pytest tests/unit/test_field_enum_intvaluemap.py -v`
Expected: FAIL — `ERR_UNKNOWN_ATTR` on the positive tests.

- [ ] **Step 3: Add `ATTR_SUBTYPE_INT_MAP` constant**

Edit `server/python/src/metaobjects/meta/core/attr/attr_constants.py` — add next to `ATTR_SUBTYPE_PROPERTIES`:

```python
ATTR_SUBTYPE_INT_MAP = "intMap"
```

- [ ] **Step 4: Add the `IntMapAttr` class**

Edit `server/python/src/metaobjects/meta/core/attr/meta_attr.py` — add next to `PropertiesAttr` (around line 131):

```python
class IntMapAttr(MetaAttr):
    """attr.intMap — an object-shaped attribute whose values are all integers
    (e.g. field.enum's @intValueMap). Generic shape check only; a consumer
    field type (field.enum) layers its own semantic rules (key-set membership,
    uniqueness) in its own content-rule validation pass."""

    @property
    def data_type(self) -> DataType:
        return DataType.OBJECT

    def coerce(self, raw: object) -> object:
        return raw

    def validate_value(self, value: object) -> list[ValueError]:
        if not isinstance(value, dict):
            return [ValueError(f"attribute '@{self.name}' must be of type 'intMap' but got {type(value).__name__}")]
        errors: list[ValueError] = []
        for key, member in value.items():
            if isinstance(member, bool) or not isinstance(member, int):
                errors.append(ValueError(f"attribute '@{self.name}' member '{key}' has value '{member}' which is not an integer"))
        return errors
```

> Check `MetaAttr`'s actual `validate_value` signature/return type (the existing `PropertiesAttr`/`FilterAttr` classes in this file don't override it, so confirm the base class's default and this override's exact contract — e.g. does it return a list of `ValueError` instances, plain strings, or something else — against `StringArrayAttr`'s override, which likely DOES override validation, before finalizing.) Note Python's `bool` is a subclass of `int` — the `isinstance(member, bool)` guard above is required to correctly reject a JSON `true`/`false` value.

- [ ] **Step 5: Register the class**

Edit the same file's registration block (around line 143-148):

```python
register_attr_class(ATTR_SUBTYPE_PROPERTIES, PropertiesAttr)
register_attr_class(ATTR_SUBTYPE_EXPRESSION, ExpressionAttr)
register_attr_class(ATTR_SUBTYPE_INT_MAP, IntMapAttr)
```

- [ ] **Step 6: Add the `attr.intMap` type declaration**

Edit `server/python/src/metaobjects/spec_metamodel/attr.json` with the same JSON snippet used in TS Task 1 Step 6 (Python's own packaged copy — keep semantically identical to the canonical spec).

- [ ] **Step 7: Add `FIELD_ATTR_INT_VALUE_MAP` constant**

Edit `server/python/src/metaobjects/field_constants.py` — add next to wherever `FIELD_ATTR_VALUES`/`ENUM_MEMBER_PATTERN` are declared (per research, `field_constants.py:147` for `ENUM_MEMBER_PATTERN`):

```python
FIELD_ATTR_INT_VALUE_MAP = "intValueMap"
```

- [ ] **Step 8: Add the `field.enum.intValueMap` declaration**

Edit `server/python/src/metaobjects/spec_metamodel/field.json` with the same JSON snippet used in TS Task 2 Step 4.

- [ ] **Step 9: Add the content-rule validation**

Edit `server/python/src/metaobjects/loader/validation_passes.py` — inside `_validate_enum_values` (shown in research at line 534), add after Rule 3 (no duplicates, ends around line 592) and before the function returns:

```python
        # Rule 4: @intValueMap content rules (optional).
        #   a. Key set must exactly match @values.
        #   b. No two members may share the same int (protobuf's stance — no
        #      alias opt-in). Every-value-is-an-integer is already enforced
        #      by IntMapAttr's generic shape validation at parse time.
        int_value_map = node.attr(FIELD_ATTR_INT_VALUE_MAP)
        if isinstance(int_value_map, dict):
            member_set = set(own_values)
            key_set = set(int_value_map.keys())
            missing = [m for m in own_values if m not in key_set]
            extra = [k for k in int_value_map if k not in member_set]
            if missing or extra:
                parts = []
                if missing:
                    parts.append(f"missing: {', '.join(missing)}")
                if extra:
                    parts.append(f"unknown: {', '.join(extra)}")
                errors.append(
                    MetaError(
                        f"{label} attribute '@{FIELD_ATTR_INT_VALUE_MAP}' keys must exactly match "
                        f"'@{FIELD_ATTR_VALUES}' members ({'; '.join(parts)}).",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        envelope=node.source,
                    )
                )

            seen_values: dict[int, str] = {}
            for member, value in int_value_map.items():
                if not isinstance(value, int) or isinstance(value, bool):
                    continue  # IntMapAttr already reported this
                owner = seen_values.get(value)
                if owner is not None:
                    errors.append(
                        MetaError(
                            f"{label} attribute '@{FIELD_ATTR_INT_VALUE_MAP}' members {owner!r} and {member!r} "
                            f"share the same value {value}; every member must have a unique int.",
                            ErrorCode.ERR_BAD_ATTR_VALUE,
                            envelope=node.source,
                        )
                    )
                else:
                    seen_values[value] = member
```

Add `FIELD_ATTR_INT_VALUE_MAP` to this file's existing import block from `field_constants`.

- [ ] **Step 10: Run tests — confirm all pass**

Run: `cd server/python && pytest tests/unit/test_field_enum_intvaluemap.py -v`
Expected: PASS — all 6 tests green.

- [ ] **Step 11: Run the full Python test suite**

Run: `cd server/python && pytest`
Expected: all pass, no regressions.

- [ ] **Step 12: Commit**

```bash
git add server/python/src/metaobjects/meta/core/attr/attr_constants.py server/python/src/metaobjects/meta/core/attr/meta_attr.py server/python/src/metaobjects/spec_metamodel/attr.json server/python/src/metaobjects/spec_metamodel/field.json server/python/src/metaobjects/field_constants.py server/python/src/metaobjects/loader/validation_passes.py server/python/tests/unit/test_field_enum_intvaluemap.py
git commit -m "feat(python): field.enum @intValueMap — explicit per-member int values for DB persistence"
```

---

### Task 11: Python — full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the shared conformance fixtures against Python's loader**

Run: `cd server/python && pytest tests/ -k conformance`
Expected: the five fixtures from Task 3 all pass.

- [ ] **Step 2: Run Python's registry-conformance test**

Run: `cd server/python && pytest tests/ -k registry_conformance`
Expected: PASS against Task 4's updated `expected-registry.json`.

- [ ] **Step 3: Run the full Python test suite**

Run: `cd server/python && pytest`
Expected: 100% pass.

---

## After this plan lands

This plan ships a fully validated, cross-port `@intValueMap` vocabulary that loads, validates, and round-trips correctly — but nothing reads it yet. Follow-on plans (one per port/group, written separately per the Scope Check in `superpowers:writing-plans`):

- **TS persistence** — migrate-ts DDL (`integer` + int `CHECK` instead of `text`/`varchar` + string `CHECK`), the migration-safety guard (D8: refuse to auto-`ALTER` an existing column across backing modes), and the Drizzle/Kysely symbol↔int codec in generated `queries.ts`/`entity.ts`.
- **C# persistence** — an EF Core `HasConversion` built from `@intValueMap`'s lookup table (replacing `HasConversion<string>()` only when `@intValueMap` is present).
- **Java + Kotlin persistence** — a new OMDB JDBC codec (binding `Types.INTEGER`, mirroring the `CurrencyCodec`/`UuidCodec` pattern in `JdbcCodecs.java`) and, for Kotlin, switching `KotlinExposedTableGenerator.kt`'s `enumerationByName(...)` to `enumeration(...)` when `@intValueMap` is present.
- **Python persistence** — a new branch in `ObjectManager`'s scalar-coercion function (currently a pure fallthrough for enums) translating symbol↔int at the DB boundary.
- **Cross-port persistence-conformance** — extend `roundtrip-all-types.yaml` + `meta.fitness.json` with an int-backed enum field, round-tripping through every port's real runtime.
