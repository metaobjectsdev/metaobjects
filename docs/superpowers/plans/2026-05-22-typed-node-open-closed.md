# Open-Closed typed nodes — attr/field value behavior on the class

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Open-Closed for typed nodes in the TS metadata package — adding an attribute or field subtype becomes one class + one registration line with zero edits to any central file. The model represents every attribute uniformly as a `MetaAttr` instance; the parser is the sole owner of inline-vs-child syntax. Straight to the end state, no backwards-compat, no dual-path.

**Architecture:** Move per-subtype value behavior (`dataType` / `coerce` / `validateValue` / `desugar`) onto `MetaAttr`/`MetaField` base classes, overridden by `FilterAttr` / `StringArrayAttr` / `PropertiesAttr` subclasses; the registry factory instantiates the right class per `(type, subType)`. `MetaData` stores attrs as `MetaAttr` instances in a name-indexed `_attrNodes` map (NOT in `_children`, so `ownChildren()`/`children()` semantics are preserved), deleting the flat `_attrs: Map<string, AttrValue>` raw map and the legacy `_effectiveAttrs` raw-map merge. The central `ATTR_DATA_TYPE`/`FIELD_DATA_TYPE` maps, the `convertToDataType` `DATA_TYPE_OBJECT` arm, the `valueMatchesType` + subtype-sets, and the parser-side `normalizeStringArrayAttr`/`normalizeFilterAttr` all collapse onto the classes. The serializer adopts one canonical rule: attrs ALWAYS emit inline `@name` (D5); the child-node attr emission path and the `inlineAttrs: false` option are removed. The cross-node `validateDataGridFilterValues` loader pass stays a loader pass. The single child-form fixture in the corpus (`attr-properties-basic`) regenerates to inline form for TS *and* C# (C# runs the same shared corpus); Java does not read that fixture and is verified-only.

**Tech Stack:** TypeScript (Bun workspace at `server/typescript/`, `bun:test`, `exactOptionalPropertyTypes: true`, ESM with `.js` import suffixes), C# (`dotnet test`), Java (Maven, JUnit — verify-only), JSON conformance fixtures at `fixtures/conformance/`.

**Spec:** `docs/superpowers/specs/2026-05-22-typed-node-open-closed-design.md`

---

## Pre-flight (do this first, once)

The worktree's `node_modules` may be empty. Without it the metadata suite shows 12 spurious failures (missing `yaml`, missing workspace-linked `@metaobjectsdev/conformance`). Establish the green baseline before touching code:

- [ ] **Install workspace deps**

Run: `cd server/typescript && bun install`
Then confirm the clean baseline:
Run: `cd server/typescript/packages/metadata && bun test`
Expected: **1008 pass, 0 fail** across 58 files. (This is the verified pre-refactor baseline as of branch `feat/typed-node-open-closed` @ `867c9c9`. If you see 12 fails with `Cannot find package 'yaml'` / `Cannot find module '@metaobjectsdev/conformance'`, the install did not link the workspace — re-run `bun install` from `server/typescript`.)

---

## Design decisions resolved during planning

These refine the spec's decisions D1–D7 into concrete implementation choices. They do not change the spec's intent — note them while executing.

1. **Attr instances live in `_attrNodes`, not `_children`.** The spec section 1 calls attrs "owned nodes (parented)". They must NOT enter the `_children` array, because `ownChildren()`/`children()` must keep excluding attrs (the round-trip comparator `assertModelsEqual` in `test/round-trip.test.ts:101-108` walks `ownChildren()` by index, and codegen/runtime never expect attr nodes in `children()`). Empirically, child-form attrs currently DO appear in `ownChildren()` (probe: `field.createdDate.ownChildren()` → `["attr.string:format"]`) — that is the very behavior the serializer's child-node emission depends on, and the behavior D2/D5 eliminate. After the refactor, attrs are reachable only via `attr()/ownAttr()/attrs()/ownAttrs()/ownMetaAttr()/ownMetaAttrs()`, never `children()`.

2. **`TypeDefinition.dataType` survives; the central `ATTR_DATA_TYPE`/`FIELD_DATA_TYPE` *lookup maps* and `dataTypeFor` are what get deleted.** The per-class `get dataType()` (keyed off `this.subType` via a small per-class static map owned by the class file) becomes the source of truth. The `def()` factory still stamps `TypeDefinition.dataType` (and the node's `_dataType`) by asking the class — so `registry.find(...).dataType` (consumed by the parser and by `test/data-type.test.ts:39-65`) and the provider-extensibility pattern (`test/data-type.test.ts:86-112`, the `field.geopoint` test) keep working with zero edits. This is the minimal change that satisfies spec section 3 ("delete the maps") while preserving the registry contract.

3. **`coerce` is the per-class entry point; the scalar helpers stay shared.** `MetaAttr.coerce(raw)` / `MetaField.coerce(raw)` resolve the node's DataType and apply scalar conversion; `FilterAttr` / `StringArrayAttr` / `PropertiesAttr` override for object/array shapes. The scalar conversion utilities (`toBoolean`/`toInteger`/`toDouble`/`toStringArray`) remain in `data-converter.ts` as internal helpers the base `coerce` calls. The standalone `convertToDataType` is retained but loses its `DATA_TYPE_OBJECT` arm (objects are now an attr-subclass concern); its remaining external consumers (`meta-field.ts` `defaultValue()`, `codegen-ts/src/column-mapper.ts`) are scalar-only and unaffected.

4. **Serializer goes always-inline (D5).** The `inlineAttrs` option and the child-node attr emission branch are removed from `serializer-json.ts`. `inferAttrSubType` STAYS (exported from the package index; needed so a programmatic `setAttr` of an undeclared attr picks the right `MetaAttr` subclass). The three serializer tests asserting child-node emission / `inlineAttrs: false` (`test/serializer-json.test.ts:498-602`) are deleted; one new test asserts the always-inline rule.

5. **Only `attr-properties-basic` regenerates, for TS *and* C#.** C# (`server/csharp/MetaObjects.Conformance.Tests`) runs the full shared `fixtures/conformance/` corpus and byte-compares `expected.json`. Its serializer (`SerializerJson.cs:158-200`) mirrors TS's old child-node emission, so regenerating `attr-properties-basic/expected.json` to inline form WILL break C# unless C# also goes always-inline. Java reads only `loader-basic-empty-package` + `smoke-empty-metadata` from the corpus and builds `attr-properties` trees in-memory (`CanonicalJsonSerializerTest.java`), so it is unaffected — verify-only.

6. **The hard break needs a registry change.** Today both `def()` registration of attr subtypes and the per-subtype dispatch maps (`VALIDATOR_CLASS_MAP`, etc.) live in `core-types.ts`. We add an `ATTR_CLASS_MAP` there mapping each attr subtype → its concrete class, exactly like the existing validator/identity/origin dispatch — this is the "one registration line" surface the Open-Closed proof test targets.

---

## Files

**Created:**
- `server/typescript/packages/metadata/src/meta/meta-attr-filter.ts` — `FilterAttr` subclass (object validation + filter desugar, moved out of `parser-core.ts`).
- `server/typescript/packages/metadata/src/meta/meta-attr-stringarray.ts` — `StringArrayAttr` subclass (bare-string→one-element-array coercion).
- `server/typescript/packages/metadata/src/meta/meta-attr-properties.ts` — `PropertiesAttr` subclass (object/string-bag validation).
- `server/typescript/packages/metadata/test/meta-attr-behavior.test.ts` — unit tests for base + subclass `dataType`/`coerce`/`validateValue`/`desugar`.
- `server/typescript/packages/metadata/test/materialized-attrs.test.ts` — `MetaData` instance-storage + accessor tests (`ownMetaAttr`/`ownMetaAttrs`, effective resolution).
- `server/typescript/packages/metadata/test/open-closed-proof.test.ts` — the executable definition of done (register `attr.fizz` + `field.fizz` via only a class + a registration line).

**Modified:**
- `server/typescript/packages/metadata/src/meta/meta-data.ts` — replace `_attrs` map with `_attrNodes: Map<string, MetaAttr>`; reimplement `setAttr`/`ownAttr`/`ownAttrs`/`ownHasAttr`/`attrs`/`attr`/`hasAttr` over instances; add `ownMetaAttr`/`ownMetaAttrs`; delete `_effectiveAttrs` raw-map merge → instance-based.
- `server/typescript/packages/metadata/src/meta/meta-attr.ts` — base `MetaAttr` gains `dataType` (by subtype) + `coerce` + `validateValue` + `desugar`; `value` reimplemented.
- `server/typescript/packages/metadata/src/meta/meta-field.ts` — base `MetaField` gains `dataType` (by subtype) + `coerce` + `validateValue`; `defaultValue()` uses `this.coerce`.
- `server/typescript/packages/metadata/src/core-types.ts` — delete `ATTR_DATA_TYPE`/`FIELD_DATA_TYPE`/`dataTypeFor`; add `ATTR_CLASS_MAP`; register the subclass per attr subtype; stamp `dataType` from the class.
- `server/typescript/packages/metadata/src/data-converter.ts` — drop the `DATA_TYPE_OBJECT` arm from `convertToDataType`; keep scalar helpers.
- `server/typescript/packages/metadata/src/parser-core.ts` — materialize all attrs into `MetaAttr` instances (inline + child form); delete `normalizeStringArrayAttr`/`normalizeFilterAttr`/`desugarFilterObject`/`desugarClause`; dispatch coerce/desugar to the instance.
- `server/typescript/packages/metadata/src/attr-schema-validate.ts` — delete `valueMatchesType` + the `STRING/NUMERIC/OBJECT_ATTR_SUBTYPES` sets; dispatch to `ownMetaAttr(name).validateValue(value)`.
- `server/typescript/packages/metadata/src/serializer-json.ts` — always-inline canonical rule; remove the child-node attr branch + `inlineAttrs` option; read from instances.
- `server/typescript/packages/metadata/src/index.ts` — drop `SerializeOptions` export if the type is removed (Task 7).
- `server/typescript/packages/metadata/test/round-trip.test.ts` — the inline-vs-child round-trip block (lines 319-372) is reframed: child-form input now round-trips to inline, attrs are no longer in `ownChildren()`.
- `server/typescript/packages/metadata/test/parser-json.test.ts` — the dual-storage assertion (lines 1154-1160) switches from `ownChildrenOfType(TYPE_ATTR)` to `ownMetaAttr("fields")`.
- `server/typescript/packages/metadata/test/serializer-json.test.ts` — delete the three child-node / `inlineAttrs:false` tests (lines 498-602); add an always-inline test.
- `server/typescript/packages/metadata/test/meta/meta-misc.test.ts` — `MetaAttr` construction/`value` tests align with the reimplemented `value`.
- `server/typescript/packages/metadata/test/index.test.ts` — drop any `inlineAttrs` usage (line ~188 region).
- `fixtures/conformance/attr-properties-basic/expected.json` — regenerated to inline `@config`.
- `server/csharp/MetaObjects/SerializerJson.cs` — always-inline attr emission (mirror D5) so the corpus stays byte-identical for C#.

**Deleted:**
- (No source files deleted — the central tables are deleted *within* `core-types.ts` / `data-converter.ts` / `attr-schema-validate.ts` / `parser-core.ts`, not whole files.)

---

# Phase 1 — Behavior on the classes

This phase adds the per-class methods and the registry dispatch. It is fully additive and ends green: nothing yet *reads* the new methods in the pipeline (the parser/serializer migration is Phase 2), but the registry now instantiates the right subclass and stamps `dataType` from the class.

### Task 1: Add `coerce`/`validateValue`/`desugar`/`dataType` to `MetaAttr` and the subclasses

**Files:**
- Modify: `server/typescript/packages/metadata/src/meta/meta-attr.ts`
- Create: `server/typescript/packages/metadata/src/meta/meta-attr-stringarray.ts`
- Create: `server/typescript/packages/metadata/src/meta/meta-attr-filter.ts`
- Create: `server/typescript/packages/metadata/src/meta/meta-attr-properties.ts`
- Test: `server/typescript/packages/metadata/test/meta-attr-behavior.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/meta-attr-behavior.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { TypeId } from "../src/registry.js";
import { MetaAttr } from "../src/meta/meta-attr.js";
import { StringArrayAttr } from "../src/meta/meta-attr-stringarray.js";
import { FilterAttr } from "../src/meta/meta-attr-filter.js";
import { PropertiesAttr } from "../src/meta/meta-attr-properties.js";
import {
  TYPE_ATTR,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
  ATTR_SUBTYPE_FILTER,
  ATTR_SUBTYPE_PROPERTIES,
} from "../src/constants.js";
import {
  DATA_TYPE_STRING,
  DATA_TYPE_INT,
  DATA_TYPE_BOOLEAN,
  DATA_TYPE_OBJECT,
} from "../src/data-type.js";

function attr(subType: string, name = "a"): MetaAttr {
  return new MetaAttr(new TypeId(TYPE_ATTR, subType), name);
}

describe("MetaAttr.dataType resolves by subtype (no central map)", () => {
  it("string → DATA_TYPE_STRING", () => {
    expect(attr(ATTR_SUBTYPE_STRING).dataType).toBe(DATA_TYPE_STRING);
  });
  it("int → DATA_TYPE_INT", () => {
    expect(attr(ATTR_SUBTYPE_INT).dataType).toBe(DATA_TYPE_INT);
  });
  it("boolean → DATA_TYPE_BOOLEAN", () => {
    expect(attr(ATTR_SUBTYPE_BOOLEAN).dataType).toBe(DATA_TYPE_BOOLEAN);
  });
  it("filter / properties → DATA_TYPE_OBJECT (via subclasses)", () => {
    expect(new FilterAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_FILTER), "f").dataType).toBe(DATA_TYPE_OBJECT);
    expect(new PropertiesAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_PROPERTIES), "p").dataType).toBe(DATA_TYPE_OBJECT);
  });
});

describe("MetaAttr.coerce", () => {
  it("int subtype coerces a numeric string to a number", () => {
    expect(attr(ATTR_SUBTYPE_INT).coerce("42")).toBe(42);
  });
  it("boolean subtype coerces 'true' to true", () => {
    expect(attr(ATTR_SUBTYPE_BOOLEAN).coerce("true")).toBe(true);
  });
  it("string subtype keeps a string", () => {
    expect(attr(ATTR_SUBTYPE_STRING).coerce("hi")).toBe("hi");
  });
});

describe("StringArrayAttr", () => {
  it("dataType is string", () => {
    expect(new StringArrayAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY), "fields").dataType).toBe(DATA_TYPE_STRING);
  });
  it("coerce wraps a bare string into a one-element array", () => {
    const a = new StringArrayAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY), "fields");
    expect(a.coerce("id")).toEqual(["id"]);
  });
  it("coerce leaves an array unchanged", () => {
    const a = new StringArrayAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY), "fields");
    expect(a.coerce(["id", "createdAt"])).toEqual(["id", "createdAt"]);
  });
  it("validateValue rejects a non-array (bare string already coerced)", () => {
    const a = new StringArrayAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY), "fields");
    expect(a.validateValue("id").length).toBeGreaterThan(0);
    expect(a.validateValue(["id"]).length).toBe(0);
  });
});

describe("FilterAttr", () => {
  const f = () => new FilterAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_FILTER), "filter");
  it("desugars scalar → eq, array → in, null → isNull", () => {
    expect(f().desugar({ subscribed: true })).toEqual({ subscribed: { eq: true } });
    expect(f().desugar({ status: ["a", "b"] })).toEqual({ status: { in: ["a", "b"] } });
    expect(f().desugar({ deletedAt: null })).toEqual({ deletedAt: { isNull: true } });
  });
  it("leaves an explicit op clause unchanged", () => {
    expect(f().desugar({ status: { like: "a%" } })).toEqual({ status: { like: "a%" } });
  });
  it("recurses into or/and composition", () => {
    expect(f().desugar({ or: [{ a: 1 }, { b: 2 }] })).toEqual({ or: [{ a: { eq: 1 } }, { b: { eq: 2 } }] });
  });
  it("validateValue accepts an object, rejects a string", () => {
    expect(f().validateValue({ a: { eq: 1 } }).length).toBe(0);
    expect(f().validateValue("oops" as unknown as Record<string, never>).length).toBeGreaterThan(0);
  });
});

describe("PropertiesAttr", () => {
  const p = () => new PropertiesAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_PROPERTIES), "config");
  it("validateValue accepts an object, rejects an array", () => {
    expect(p().validateValue({ owner: "growth" }).length).toBe(0);
    expect(p().validateValue(["a"]).length).toBeGreaterThan(0);
  });
  it("desugar is identity", () => {
    expect(p().desugar({ owner: "growth" })).toEqual({ owner: "growth" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/meta-attr-behavior.test.ts`
Expected: FAIL — the subclass modules don't exist and the base methods aren't defined.

- [ ] **Step 3: Rewrite `meta-attr.ts` base class**

Replace the entire body of `server/typescript/packages/metadata/src/meta/meta-attr.ts` with:

```ts
// MetaAttr — concrete node class for type=attr nodes.
//
// Every attribute in the loaded model is a MetaAttr instance (inline @-syntax is
// parse-time sugar; see parser-core.ts). The base class owns value behavior —
// dataType / coerce / validateValue / desugar — resolved by this.subType.
// Subclasses (StringArrayAttr, FilterAttr, PropertiesAttr) override only what
// differs. Adding a new value-shaped attr subtype is one subclass + one
// registration line in core-types.ts (ATTR_CLASS_MAP) — zero central edits.

import { MetaData, type AttrValue } from "./meta-data.js";
import {
  type DataType,
  type DataTypeAware,
  DATA_TYPE_STRING,
  DATA_TYPE_INT,
  DATA_TYPE_LONG,
  DATA_TYPE_DOUBLE,
  DATA_TYPE_BOOLEAN,
} from "../data-type.js";
import { convertToDataType } from "../data-converter.js";
import {
  RESERVED_KEY_VALUE,
  SUBTYPE_BASE,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
} from "../constants.js";

/** A value-level validation finding, surfaced by the attr-schema pass. */
export interface ValueError {
  message: string;
}

/** Base-subtype → DataType. Each MetaAttr subclass owns its own DataType: the
 *  base covers the scalar/string subtypes; object/array subtypes override
 *  `get dataType()`. This replaces the central ATTR_DATA_TYPE map. */
const BASE_ATTR_DATA_TYPE: Readonly<Record<string, DataType>> = {
  [SUBTYPE_BASE]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_STRING]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_CLASS]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_INT]: DATA_TYPE_INT,
  [ATTR_SUBTYPE_LONG]: DATA_TYPE_LONG,
  [ATTR_SUBTYPE_DOUBLE]: DATA_TYPE_DOUBLE,
  [ATTR_SUBTYPE_BOOLEAN]: DATA_TYPE_BOOLEAN,
};

export class MetaAttr extends MetaData implements DataTypeAware {
  /** This attribute's coerced value (stored on the instance under RESERVED_KEY_VALUE). */
  get value(): AttrValue | undefined {
    return this.ownAttr(RESERVED_KEY_VALUE);
  }

  /** The coarse value-type classification for this attribute's subtype. */
  get dataType(): DataType {
    return BASE_ATTR_DATA_TYPE[this.subType] ?? DATA_TYPE_STRING;
  }

  /**
   * Coerce a raw parsed value toward this attr's value shape. The base handles
   * the scalar subtypes (string / class / int / long / double / boolean) by
   * delegating to convertToDataType. Subclasses override for array/object shapes.
   */
  coerce(raw: unknown): AttrValue {
    return convertToDataType(this.dataType, raw);
  }

  /**
   * Desugar a coerced value to its canonical stored form. Default identity;
   * FilterAttr overrides to normalize `{ field: value }` → `{ field: { op: value } }`.
   */
  desugar(value: AttrValue): AttrValue {
    return value;
  }

  /**
   * Validate a stored value against this attr's value shape. Returns [] when
   * valid. The base checks the scalar/string subtypes; subclasses override for
   * array/object shapes. Replaces the central valueMatchesType + subtype-sets.
   */
  validateValue(value: AttrValue): ValueError[] {
    const dt = this.dataType;
    if (dt === DATA_TYPE_STRING) {
      return typeof value === "string" ? [] : [this._typeError("string", value)];
    }
    if (dt === DATA_TYPE_INT || dt === DATA_TYPE_LONG || dt === DATA_TYPE_DOUBLE) {
      return typeof value === "number" ? [] : [this._typeError("number", value)];
    }
    if (dt === DATA_TYPE_BOOLEAN) {
      return typeof value === "boolean" ? [] : [this._typeError("boolean", value)];
    }
    // SUBTYPE_BASE / unconstrained — accept anything.
    return [];
  }

  protected _typeError(expected: string, value: AttrValue): ValueError {
    return {
      message:
        `attribute '@${this.name}' must be of type '${this.subType}' ` +
        `but got ${runtimeTypeName(value)}`,
    };
  }
}

/** Human-readable runtime type of an attr value, for error messages. */
export function runtimeTypeName(value: AttrValue): string {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return typeof value;
}
```

> Note: `expected` is unused in `_typeError` today but kept on the signature so subclasses can produce richer messages without a base-class change; if the project's lint flags the unused param, prefix it `_expected`. The contract the attr-schema pass relies on is "non-empty array means invalid"; the exact message text is not asserted by conformance.

- [ ] **Step 4: Create `StringArrayAttr`**

Create `server/typescript/packages/metadata/src/meta/meta-attr-stringarray.ts`:

```ts
// StringArrayAttr — attr subtype `stringarray`. A bare string is the degenerate
// one-element authoring form (`"@fields": "id"`); coerce wraps it into a
// one-element array so the loaded tree always holds a real string[]. Moved here
// from parser-core.ts `normalizeStringArrayAttr`.

import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "./meta-data.js";
import { DATA_TYPE_STRING, type DataType } from "../data-type.js";

export class StringArrayAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_STRING;
  }

  override coerce(raw: unknown): AttrValue {
    if (Array.isArray(raw)) return raw.map((el) => String(el));
    if (typeof raw === "string") return [raw];
    // Non-string scalar (number/boolean) → leave as-is so validateValue flags it.
    return raw as AttrValue;
  }

  override validateValue(value: AttrValue): ValueError[] {
    return Array.isArray(value) && value.every((el) => typeof el === "string")
      ? []
      : [{ message: `attribute '@${this.name}' must be a string[] but got ${runtimeTypeName(value)}` }];
  }
}
```

- [ ] **Step 5: Create `FilterAttr`**

Create `server/typescript/packages/metadata/src/meta/meta-attr-filter.ts`:

```ts
// FilterAttr — attr subtype `filter`. Object-shaped value; desugars a preset
// filter to canonical `{ field: { op: value } }` form (scalar→eq, array→in,
// null→isNull; or/and recurse). Moved here from parser-core.ts
// `normalizeFilterAttr` / `desugarFilterObject` / `desugarClause`.

import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue, type AttrObject, type AttrJson } from "./meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../data-type.js";
import {
  FILTER_OP_EQ,
  FILTER_OP_IN,
  FILTER_OP_IS_NULL,
  FILTER_COMPOSE_OR,
  FILTER_COMPOSE_AND,
} from "../constants.js";

export class FilterAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_OBJECT;
  }

  override coerce(raw: unknown): AttrValue {
    // Object stored verbatim; a non-object (e.g. a legacy JSON string) is
    // returned as-is so validateValue rejects it.
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as AttrValue)
      : (raw as AttrValue);
  }

  override desugar(value: AttrValue): AttrValue {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    return desugarFilterObject(value as AttrObject);
  }

  override validateValue(value: AttrValue): ValueError[] {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? []
      : [{ message: `attribute '@${this.name}' must be of type 'filter' but got ${runtimeTypeName(value)}` }];
  }
}

function desugarFilterObject(filter: AttrObject): AttrObject {
  const out: Record<string, AttrJson> = {};
  for (const [key, raw] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_OR || key === FILTER_COMPOSE_AND) {
      out[key] = Array.isArray(raw)
        ? raw.map((sub: AttrJson) =>
            typeof sub === "object" && sub !== null && !Array.isArray(sub)
              ? desugarFilterObject(sub as AttrObject)
              : sub,
          )
        : (raw as AttrJson);
      continue;
    }
    out[key] = desugarClause(raw);
  }
  return out;
}

function desugarClause(raw: AttrJson): AttrObject {
  if (raw === null) return { [FILTER_OP_IS_NULL]: true };
  if (Array.isArray(raw)) return { [FILTER_OP_IN]: raw };
  if (typeof raw === "object") return raw as AttrObject;
  return { [FILTER_OP_EQ]: raw };
}
```

> This is a verbatim move of the `desugarFilterObject`/`desugarClause` functions currently in `parser-core.ts:609-632` — preserve their logic exactly so canonical output is unchanged.

- [ ] **Step 6: Create `PropertiesAttr`**

Create `server/typescript/packages/metadata/src/meta/meta-attr-properties.ts`:

```ts
// PropertiesAttr — attr subtype `properties`. Object-shaped value (a string
// bag / arbitrary JSON object). No desugar (identity); object validation.

import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "./meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../data-type.js";

export class PropertiesAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_OBJECT;
  }

  override coerce(raw: unknown): AttrValue {
    return raw as AttrValue;
  }

  override validateValue(value: AttrValue): ValueError[] {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? []
      : [{ message: `attribute '@${this.name}' must be of type 'properties' but got ${runtimeTypeName(value)}` }];
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/meta-attr-behavior.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 8: Typecheck the package**

Run: `cd server/typescript/packages/metadata && bunx tsc -p tsconfig.typecheck.json --noEmit`
Expected: PASS. (`meta-data.ts` still has its `_attrs` map at this point — `meta-attr.ts` only adds methods; no callsite breaks yet.)

- [ ] **Step 9: Commit**

```bash
git add server/typescript/packages/metadata/src/meta/meta-attr.ts \
  server/typescript/packages/metadata/src/meta/meta-attr-stringarray.ts \
  server/typescript/packages/metadata/src/meta/meta-attr-filter.ts \
  server/typescript/packages/metadata/src/meta/meta-attr-properties.ts \
  server/typescript/packages/metadata/test/meta-attr-behavior.test.ts
git commit -m "feat(metadata): value behavior on MetaAttr + FilterAttr/StringArrayAttr/PropertiesAttr subclasses"
```

---

### Task 2: Add `dataType`/`coerce`/`validateValue` to `MetaField`

**Files:**
- Modify: `server/typescript/packages/metadata/src/meta/meta-field.ts`
- Test: append to `server/typescript/packages/metadata/test/meta-attr-behavior.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/typescript/packages/metadata/test/meta-attr-behavior.test.ts`:

```ts
import { MetaField } from "../src/meta/meta-field.js";
import {
  TYPE_FIELD,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
} from "../src/constants.js";
import { DATA_TYPE_LONG } from "../src/data-type.js";

describe("MetaField.dataType resolves by subtype (no central map)", () => {
  it("int → DATA_TYPE_INT, currency → DATA_TYPE_LONG, string → DATA_TYPE_STRING", () => {
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "n").dataType).toBe(DATA_TYPE_INT);
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY), "c").dataType).toBe(DATA_TYPE_LONG);
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "s").dataType).toBe(DATA_TYPE_STRING);
  });
  it("coerce honors the field subtype", () => {
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "n").coerce("7")).toBe(7);
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_BOOLEAN), "b").coerce("true")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/meta-attr-behavior.test.ts`
Expected: FAIL — `MetaField.dataType` currently reads `this._dataType` (still set by the factory), so it may PASS for int/string but the `coerce` method does not exist yet. (At minimum the `coerce` assertions fail.)

- [ ] **Step 3: Rewrite `MetaField.dataType` to resolve by subtype + add `coerce`**

In `server/typescript/packages/metadata/src/meta/meta-field.ts`, add a per-subtype map and replace the `dataType` getter. Add the imports (`DATA_TYPE_*` from `../data-type.js`, `FIELD_SUBTYPE_*` and `SUBTYPE_BASE` from `../constants.js`) and define near the top of the file:

```ts
const FIELD_DATA_TYPE: Readonly<Record<string, DataType>> = {
  [SUBTYPE_BASE]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_STRING]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_CLASS]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_INT]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_SHORT]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_BYTE]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_LONG]: DATA_TYPE_LONG,
  [FIELD_SUBTYPE_CURRENCY]: DATA_TYPE_LONG,
  [FIELD_SUBTYPE_DOUBLE]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_FLOAT]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_DECIMAL]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_BOOLEAN]: DATA_TYPE_BOOLEAN,
  [FIELD_SUBTYPE_DATE]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_TIME]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_TIMESTAMP]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_OBJECT]: DATA_TYPE_OBJECT,
};
```

> This is the same table currently in `core-types.ts:158-175` (the `FIELD_DATA_TYPE` const) — move it here verbatim. It is deleted from `core-types.ts` in Task 4. Co-locating it with the class is the Open-Closed win: a provider's field-subtype class owns its own datatype (cf. the `field.geopoint` extensibility test).

Replace the `dataType` getter (lines 26-29):

```ts
  /** The coarse value-type classification for this field's subtype. */
  override get dataType(): DataType {
    return FIELD_DATA_TYPE[this.subType] ?? this._dataType ?? DATA_TYPE_STRING;
  }
```

> The `?? this._dataType` fallback keeps a provider-registered subtype (whose class isn't in this map, e.g. `field.geopoint`) working via the factory's `setDataType`. Core subtypes resolve from the map; novel subtypes fall back to the registry-stamped `_dataType`.

Add a `coerce` method (after `defaultValue()`), and rewrite `defaultValue()` to use it:

```ts
  /** Coerce a raw value toward this field's DataType (Java DataConverter parity). */
  coerce(raw: unknown): AttrValue {
    return convertToDataType(this.dataType, raw);
  }
```

Change `defaultValue()`'s body from `return convertToDataType(this.dataType, raw);` to `return this.coerce(raw);`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server/typescript/packages/metadata && bun test test/meta-attr-behavior.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd server/typescript/packages/metadata && bunx tsc -p tsconfig.typecheck.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/meta/meta-field.ts \
  server/typescript/packages/metadata/test/meta-attr-behavior.test.ts
git commit -m "feat(metadata): MetaField.dataType resolves by subtype; add MetaField.coerce"
```

---

### Task 3: Register the attr subclasses in the factory; stamp `dataType` from the class

**Files:**
- Modify: `server/typescript/packages/metadata/src/core-types.ts`
- Test: `server/typescript/packages/metadata/test/data-type.test.ts` (no change yet — must keep passing)

- [ ] **Step 1: Add `ATTR_CLASS_MAP` and use it in the attr-registration loop**

In `core-types.ts`, add imports for the subclasses near the existing `MetaAttr` import (line 19):

```ts
import { StringArrayAttr } from "./meta/meta-attr-stringarray.js";
import { FilterAttr } from "./meta/meta-attr-filter.js";
import { PropertiesAttr } from "./meta/meta-attr-properties.js";
```

After the `ORIGIN_CLASS_MAP` definition (line 221), add:

```ts
/** Map from attr subtype string → concrete node constructor. Default (and the
 *  scalar/string subtypes) → MetaAttr. This is the single "one registration
 *  line per subtype" surface the Open-Closed proof targets. */
const ATTR_CLASS_MAP = new Map<string, NodeConstructor>([
  [ATTR_SUBTYPE_STRINGARRAY, StringArrayAttr],
  [ATTR_SUBTYPE_FILTER, FilterAttr],
  [ATTR_SUBTYPE_PROPERTIES, PropertiesAttr],
]);
```

- [ ] **Step 2: Stamp `dataType` from the class, not from the deleted maps**

The attr-registration loop (lines 270-276) currently calls `dataTypeFor(ATTR_DATA_TYPE, subType, "attr")`. Replace it so the dataType comes from a freshly-instantiated node of the right class (the class is now the source of truth):

```ts
  // attr — 9 subtypes, no children allowed. Each subtype's class owns its
  // dataType (resolved by this.subType); we read it off a probe instance so the
  // TypeDefinition.dataType contract (registry.find(...).dataType) still holds.
  for (const subType of ATTR_SUBTYPES) {
    const AttrClass = ATTR_CLASS_MAP.get(subType) ?? MetaAttr;
    const probeDataType = new AttrClass(new TypeId(TYPE_ATTR, subType), "").dataType;
    registry.register(
      def(TYPE_ATTR, subType, `Attribute of type ${subType}`, [], AttrClass, [], probeDataType),
    );
  }
```

> The `def()` helper already calls `node.setDataType(dataType)` and stamps `TypeDefinition.dataType` (lines 144-153) — unchanged. We simply source the dataType from the class instead of the deleted map.

- [ ] **Step 3: Do the same for fields** (read dataType off a `MetaField` probe)

Replace the field-registration `dataTypeFor(FIELD_DATA_TYPE, subType, "field")` call (line 266) with:

```ts
        new MetaField(new TypeId(TYPE_FIELD, subType), "").dataType),
```

so the full `registry.register` call reads:

```ts
    registry.register(
      def(TYPE_FIELD, subType, `Field of type ${subType}`, fieldRules, MetaField, fieldAttrs,
        new MetaField(new TypeId(TYPE_FIELD, subType), "").dataType),
    );
```

- [ ] **Step 4: Delete the central maps + `dataTypeFor`**

Delete `FIELD_DATA_TYPE` (lines 156-175), `ATTR_DATA_TYPE` (lines 177-189), and `dataTypeFor` (lines 191-199) from `core-types.ts`. Remove the now-unused imports they referenced (`DATA_TYPE_*`, the `ATTR_SUBTYPE_*` / `FIELD_SUBTYPE_*` that are no longer referenced in this file). Let typecheck guide which imports to drop.

- [ ] **Step 5: Run the dataType test to verify it still passes**

Run: `cd server/typescript/packages/metadata && bun test test/data-type.test.ts`
Expected: PASS — `registry.find(TYPE_ATTR, ATTR_SUBTYPE_PROPERTIES).dataType` is `"object"`, fields/attrs all stamp the right dataType, and the `field.geopoint` extensibility test still passes (it sets its own `dataType` on its def + node).

- [ ] **Step 6: Typecheck**

Run: `cd server/typescript/packages/metadata && bunx tsc -p tsconfig.typecheck.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/metadata/src/core-types.ts
git commit -m "feat(metadata): factory dispatches attr subclasses; delete ATTR_DATA_TYPE/FIELD_DATA_TYPE/dataTypeFor"
```

---

# Phase 2 — Materialization, parser, validator, serializer

This is the big coherent change: storage + accessors + parser + validator + serializer must move together to a compiling, green state (spec D6 — no half-migrated dual-path). Tasks 4–7 land in sequence but the metadata package only returns fully green at the **end of Task 7**; Tasks 4–6 may leave intermediate red between the storage rewrite and the parser/serializer rewrite. Each task still leads with its tests. Commit at each task boundary even if the package suite is not yet fully green, noting it in the commit body — Task 7 closes it.

### Task 4: Convert `MetaData` storage to `MetaAttr` instances

**Files:**
- Modify: `server/typescript/packages/metadata/src/meta/meta-data.ts`
- Test: `server/typescript/packages/metadata/test/materialized-attrs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/materialized-attrs.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { TypeId } from "../src/registry.js";
import { MetaObject } from "../src/meta/meta-object.js";
import { MetaAttr } from "../src/meta/meta-attr.js";
import { StringArrayAttr } from "../src/meta/meta-attr-stringarray.js";
import {
  TYPE_OBJECT,
  OBJECT_SUBTYPE_ENTITY,
  ATTR_SUBTYPE_STRINGARRAY,
} from "../src/constants.js";

function obj(name = "Subscriber"): MetaObject {
  return new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), name);
}

describe("MetaData materialized attrs", () => {
  it("setAttr of a scalar is readable via ownAttr/attr and is a MetaAttr instance", () => {
    const o = obj();
    o.setAttr("dbTable", "subscriber_t");
    expect(o.ownAttr("dbTable")).toBe("subscriber_t");
    expect(o.attr("dbTable")).toBe("subscriber_t");
    expect(o.ownHasAttr("dbTable")).toBe(true);
    expect(o.hasAttr("dbTable")).toBe(true);
    const inst = o.ownMetaAttr("dbTable");
    expect(inst).toBeInstanceOf(MetaAttr);
    expect(inst!.value).toBe("subscriber_t");
  });

  it("ownAttrs() returns a value map, not instances", () => {
    const o = obj();
    o.setAttr("a", 1);
    o.setAttr("b", "x");
    expect([...o.ownAttrs().entries()]).toEqual([
      ["a", 1],
      ["b", "x"],
    ]);
  });

  it("ownMetaAttrs() returns instances in insertion order", () => {
    const o = obj();
    o.setAttr("a", 1);
    o.setAttr("b", "x");
    expect(o.ownMetaAttrs().map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("attrs are NOT exposed as children", () => {
    const o = obj();
    o.setAttr("a", 1);
    expect(o.ownChildren().length).toBe(0);
    expect(o.children().length).toBe(0);
  });

  it("effective attrs walk the super chain, own wins", () => {
    const base = obj("Base");
    base.setAttr("shared", "from-base");
    base.setAttr("baseOnly", "b");
    const sub = obj("Sub");
    sub.setSuperResolved(base);
    sub.setAttr("shared", "from-sub");
    expect(sub.attr("shared")).toBe("from-sub");
    expect(sub.attr("baseOnly")).toBe("b");
    expect([...sub.attrs().keys()].sort()).toEqual(["baseOnly", "shared"]);
    // own-only excludes inherited
    expect(sub.ownHasAttr("baseOnly")).toBe(false);
  });

  it("setAttr of an undeclared array infers a StringArrayAttr instance", () => {
    const o = obj();
    o.setAttr("fields", ["id"]);
    expect(o.ownMetaAttr("fields")).toBeInstanceOf(StringArrayAttr);
    expect(o.ownAttr("fields")).toEqual(["id"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/materialized-attrs.test.ts`
Expected: FAIL — `ownMetaAttr`/`ownMetaAttrs` don't exist; `setAttr` stores raw values.

- [ ] **Step 3: Rewrite the storage + accessors in `meta-data.ts`**

In `server/typescript/packages/metadata/src/meta/meta-data.ts`:

(a) Add the imports at the top (after the existing `TypeId` import):

```ts
import { MetaAttr } from "./meta-attr.js";
import { inferAttrSubType } from "../serializer-json.js";
import { attrClassFor } from "../core-types.js";
import { RESERVED_KEY_VALUE, TYPE_ATTR } from "../constants.js";
```

> **Cycle note:** `meta-data.ts` importing `meta-attr.ts` (which imports `meta-data.ts`) is a class-extends cycle — fine at runtime under ESM as long as `MetaAttr` is only *referenced* (constructed), not used at module-eval time. `inferAttrSubType` lives in `serializer-json.ts` which imports only types from `meta-data.ts` — also fine. `attrClassFor` is a new exported helper added to `core-types.ts` in Step 4 below (returns the subclass constructor for an attr subtype). If the bundler flags an initialization-order error on `attrClassFor`, fall back to a lazy `await import` is NOT allowed (sync path); instead move `ATTR_CLASS_MAP` + `attrClassFor` into a new leaf module `src/attr-class-map.ts` imported by both `core-types.ts` and `meta-data.ts`. Decide by running the test in Step 6; if it throws a "cannot access before initialization", create `attr-class-map.ts` and re-point both imports.

(b) Replace the field declaration (line 39):

```ts
  // Internal storage — attributes as MetaAttr instances, name-indexed and
  // insertion-ordered. NOT in _children (attrs never appear in ownChildren()).
  private _attrNodes = new Map<string, MetaAttr>();
```

(c) Reimplement the attribute accessors (replace lines 184-231):

```ts
  setAttr(name: string, value: AttrValue): void {
    this._assertNotFrozen();
    const existing = this._attrNodes.get(name);
    if (existing !== undefined) {
      existing.setAttr(RESERVED_KEY_VALUE, value);
      return;
    }
    // Resolve the attr's class. A declared subtype isn't known here (this is the
    // node, not the registry), so infer from the value shape — same rule the
    // serializer uses. The parser, which DOES know the declared subtype, builds
    // the instance directly via setMetaAttr (below).
    const subType = inferAttrSubType(value);
    const AttrClass = attrClassFor(subType);
    const node = new AttrClass(new TypeId(TYPE_ATTR, subType), name);
    node.setAttr(RESERVED_KEY_VALUE, value);
    this._attrNodes.set(name, node);
  }

  /** Attach a pre-built MetaAttr instance (the parser path, which knows the
   *  declared subtype). Replaces any existing attr of the same name. */
  setMetaAttr(node: MetaAttr): void {
    this._assertNotFrozen();
    this._attrNodes.set(node.name, node);
  }

  /** Own (locally declared) attr value for `name`, or undefined — excludes inherited. */
  ownAttr(name: string): AttrValue | undefined {
    return this._attrNodes.get(name)?.value;
  }

  /** Own (locally declared) MetaAttr instance for `name`, or undefined. */
  ownMetaAttr(name: string): MetaAttr | undefined {
    return this._attrNodes.get(name);
  }

  /** Own MetaAttr instances, insertion-ordered, frozen; excludes inherited. */
  ownMetaAttrs(): readonly MetaAttr[] {
    return this.cached("ownMetaAttrs", () => Object.freeze([...this._attrNodes.values()]));
  }

  /** Own (locally declared) attr value map; excludes inherited. Cached. */
  ownAttrs(): ReadonlyMap<string, AttrValue> {
    return this.cached("ownAttrs", () => {
      const m = new Map<string, AttrValue>();
      for (const [name, node] of this._attrNodes) {
        if (node.value !== undefined) m.set(name, node.value);
      }
      return m;
    });
  }

  /** True if `name` is an own (locally declared) attr — excludes inherited. */
  ownHasAttr(name: string): boolean {
    return this._attrNodes.has(name);
  }

  attrs(): ReadonlyMap<string, AttrValue> {
    return this.cached("attrs", () => this._effectiveAttrs(new Set([this])));
  }

  attr(name: string): AttrValue | undefined {
    return this.attrs().get(name);
  }

  hasAttr(name: string): boolean {
    return this.attrs().has(name);
  }
```

(d) Reimplement `_effectiveAttrs` (replace lines 317-328) to walk instances:

```ts
  private _effectiveAttrs(visited: Set<MetaData>): Map<string, AttrValue> {
    const ownValues = (): Map<string, AttrValue> => {
      const m = new Map<string, AttrValue>();
      for (const [name, node] of this._attrNodes) {
        if (node.value !== undefined) m.set(name, node.value);
      }
      return m;
    };
    if (this._superData === undefined || visited.has(this._superData)) {
      return ownValues();
    }
    visited.add(this._superData);
    const result = this._superData._effectiveAttrs(visited);
    for (const [k, v] of ownValues()) {
      result.set(k, v);
    }
    return result;
  }
```

> Semantics preserved: super-chain first, own overrides — identical to the old raw-map merge, now over instances. Last-writer-wins on a key conflict is unchanged.

- [ ] **Step 4: Export `attrClassFor` from `core-types.ts`**

In `core-types.ts`, after the `ATTR_CLASS_MAP` definition (Task 3), add:

```ts
/** The concrete MetaAttr subclass for an attr subtype (default MetaAttr). Used
 *  by MetaData.setAttr to materialize an undeclared attr as the right class. */
export function attrClassFor(subType: string): NodeConstructor {
  return ATTR_CLASS_MAP.get(subType) ?? MetaAttr;
}
```

> If Step 3's cycle note forces a leaf module: create `src/attr-class-map.ts` exporting `ATTR_CLASS_MAP` + `attrClassFor` + the `NodeConstructor` type, import it from both `core-types.ts` (for the registration loop) and `meta-data.ts`.

- [ ] **Step 5: Update the `assertModelsEqual` round-trip comparator (it reads `ownAttrs()`, still works)**

No change needed — `assertModelsEqual` (`test/round-trip.test.ts:82-98`) reads `ownAttrs()`, which still returns a value map. But its child-count assertion (lines 101-108) now sees zero attr nodes on both sides (consistent), so it stays correct.

- [ ] **Step 6: Run the materialization test**

Run: `cd server/typescript/packages/metadata && bun test test/materialized-attrs.test.ts`
Expected: PASS. If a "cannot access 'attrClassFor' before initialization" error appears, apply the leaf-module fallback from Step 3's cycle note, then re-run.

- [ ] **Step 7: Commit (note: package not yet fully green — parser/serializer follow)**

```bash
git add server/typescript/packages/metadata/src/meta/meta-data.ts \
  server/typescript/packages/metadata/src/core-types.ts \
  server/typescript/packages/metadata/test/materialized-attrs.test.ts
git commit -m "feat(metadata): store attrs as MetaAttr instances; add ownMetaAttr/ownMetaAttrs; instance-based effective resolution

Parser + serializer still reference the old child-attr path; Task 7 closes the suite green."
```

---

### Task 5: Parser materializes all attrs into instances

**Files:**
- Modify: `server/typescript/packages/metadata/src/parser-core.ts`
- Test: `server/typescript/packages/metadata/test/parser-json.test.ts` (migrate the dual-storage assertion)

- [ ] **Step 1: Migrate the dual-storage parser test to instances**

In `server/typescript/packages/metadata/test/parser-json.test.ts`, replace the child-attr-node block (lines 1154-1160) with an instance check:

```ts
    // The materialized MetaAttr instance carries the same desugared array.
    const attrInst = identity.ownMetaAttr("fields");
    expect(attrInst).toBeDefined();
    expect(Array.isArray(attrInst!.value)).toBe(true);
    expect(attrInst!.value).toEqual(["id"]);
```

Remove the now-unused `MetaAttr` import if it becomes unused (check the file's other `MetaAttr` usages first; `grep -n "MetaAttr" test/parser-json.test.ts`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/parser-json.test.ts`
Expected: FAIL — `identity.ownMetaAttr("fields")` returns an instance whose value was set via the old raw `setAttr` path (which now infers a `StringArrayAttr` from the array — should actually PASS for that assertion), but the parser still calls the deleted `normalizeStringArrayAttr` etc. The compile/runtime error from the parser referencing removed helpers (next steps) is the real failure surface. If the assertion passes but other parser-json tests error, that confirms the parser rewrite is needed.

- [ ] **Step 3: Rewrite `applyInlineAttrsAndUnknownKeys`** (lines 641-695)

Replace the inline-attr application so it builds a `MetaAttr` instance via the registry factory (right class), calls `instance.coerce(raw)` then `instance.desugar(...)`, and attaches via `setMetaAttr`:

```ts
function applyInlineAttrsAndUnknownKeys(
  model: MetaData,
  nodeData: Record<string, unknown>,
  strict: boolean,
  source: string | undefined,
  path: string,
  warnings: string[],
  registry: TypeRegistry,
): void {
  for (const key of Object.keys(nodeData)) {
    if (RESERVED_KEYS.has(key)) continue;

    if (!key.startsWith(ATTR_PREFIX)) {
      const displayName =
        model.name !== "" ? `${model.type}.${model.subType} '${model.name}'` : `${model.type}.${model.subType}`;
      reportProblem(
        `Unknown key '${key}' on ${displayName} at ${path} (must be reserved or ${ATTR_PREFIX}-prefixed)`,
        strict, warnings, source, path, "ERR_UNKNOWN_ATTR",
      );
      continue;
    }

    const attrName = key.slice(ATTR_PREFIX.length);
    const rawVal = nodeData[key];

    try {
      const attr = materializeAttr(model, attrName, rawVal, registry);
      model.setMetaAttr(attr);
    } catch (err) {
      reportProblem(
        `Failed to convert attribute "${ATTR_PREFIX}${attrName}" at ${path}: ${(err as Error).message}`,
        strict, warnings, source, path, "ERR_BAD_ATTR_VALUE",
      );
    }
  }
}

// Materialize a single attr into the right MetaAttr subclass: declared subtype
// from the owner's AttrSchema (if any), else inferred from the value shape. The
// instance coerces + desugars its own value.
function materializeAttr(
  owner: MetaData,
  attrName: string,
  rawVal: unknown,
  registry: TypeRegistry,
): MetaAttr {
  const attrSpec = registry.attrsOf(owner.type, owner.subType).find((s) => s.name === attrName);
  let subType: string;
  if (attrSpec !== undefined && attrSpec.valueType !== undefined) {
    subType = attrSpec.valueType;
  } else {
    // Undeclared or declared-but-untyped (@default): preserve the author's shape.
    subType = inferUndeclaredAttrSubType(rawVal);
  }
  const def = registry.find(TYPE_ATTR, subType);
  const node = (def !== undefined
    ? def.factory(def.typeId, attrName)
    : new MetaAttr(new TypeId(TYPE_ATTR, subType), attrName)) as MetaAttr;
  const coerced = node.coerce(rawVal);
  const desugared = node.desugar(coerced);
  node.setAttr(RESERVED_KEY_VALUE, desugared);
  return node;
}
```

Add a small helper that mirrors the old `toAttrValue` shape-preservation for undeclared attrs (so a numeric-looking string stays a string, etc.). Place it near `materializeAttr`:

```ts
// Undeclared attr → pick the subtype from the value's runtime shape, preserving
// type (a numeric string stays string). Mirrors the old toAttrValue contract:
// object/null are not valid undeclared attr values UNLESS the value is a plain
// object (then it's a properties-style attr). Arrays → stringarray.
function inferUndeclaredAttrSubType(raw: unknown): string {
  if (Array.isArray(raw)) return ATTR_SUBTYPE_STRINGARRAY;
  if (raw === null || raw === undefined) {
    throw new Error(`${typeof raw} is not a valid attr value`);
  }
  if (typeof raw === "object") return ATTR_SUBTYPE_PROPERTIES;
  if (typeof raw === "boolean") return ATTR_SUBTYPE_BOOLEAN;
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= JAVA_INT_MIN && raw <= JAVA_INT_MAX
      ? ATTR_SUBTYPE_INT
      : (Number.isInteger(raw) ? ATTR_SUBTYPE_LONG : ATTR_SUBTYPE_DOUBLE);
  }
  return ATTR_SUBTYPE_STRING;
}
```

> Add `JAVA_INT_MIN`/`JAVA_INT_MAX` consts (same values as in `serializer-json.ts:54-55`) at the top of `parser-core.ts`, OR import `inferAttrSubType` from `serializer-json.ts` and use it directly for the undeclared case (it already implements this exact int/long/double/boolean/stringarray rule). **Prefer importing `inferAttrSubType`** to avoid duplicating the int-range logic — but note `inferAttrSubType` maps a plain object to `ATTR_SUBTYPE_STRING` (it predates object attrs); for the undeclared-object case you still need the `typeof raw === "object" → ATTR_SUBTYPE_PROPERTIES` branch here. Keep `inferUndeclaredAttrSubType` as the parser's wrapper that adds the object + null-reject branches around a call to `inferAttrSubType` for the scalar/array cases.

The simplest correct form:

```ts
function inferUndeclaredAttrSubType(raw: unknown): string {
  if (raw === null || raw === undefined) {
    throw new Error(`${raw === null ? "null" : "undefined"} is not a valid attr value`);
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return ATTR_SUBTYPE_PROPERTIES;
  return inferAttrSubType(raw as AttrValue);
}
```

Add imports to `parser-core.ts`: `MetaAttr` from `./meta/meta-attr.js`, `inferAttrSubType` from `./serializer-json.js`, and constants `ATTR_SUBTYPE_PROPERTIES` (already present? check; add if missing). Remove imports that become unused after deletions (`convertToDataType`, `toAttrValue`, `DATA_TYPE_STRING`, the `FILTER_OP_*`/`FILTER_COMPOSE_*`, `ATTR_SUBTYPE_STRINGARRAY`/`ATTR_SUBTYPE_FILTER`, `AttrObject`/`AttrJson`) — typecheck will list them.

- [ ] **Step 4: Rewrite `parseAttrChild`** (lines 817-896) to materialize an instance and attach via `setMetaAttr` (NOT `addChild`)

```ts
function parseAttrChild(
  parent: MetaData,
  attrType: string,
  attrSubType: string,
  attrData: Record<string, unknown>,
  registry: TypeRegistry,
  warnings: string[],
  strict: boolean,
  source: string | undefined,
  path: string,
): void {
  const attrName = attrData[RESERVED_KEY_NAME];
  const attrValue = attrData[RESERVED_KEY_VALUE];

  if (typeof attrName !== "string" || attrName === "") {
    reportProblem(
      `attr child at ${path} requires a non-empty "${RESERVED_KEY_NAME}" string`,
      strict, warnings, source, path, "ERR_MISSING_REQUIRED_ATTR",
    );
    return;
  }
  if (attrValue === undefined) {
    reportProblem(
      `attr child "${attrName}" at ${path} is missing "${RESERVED_KEY_VALUE}"`,
      strict, warnings, source, path, "ERR_MISSING_REQUIRED_ATTR",
    );
    return;
  }

  // Resolve the attr node's own subtype (fall back to base if unregistered).
  const resolvedSubType =
    registry.has(attrType, attrSubType) || !registry.has(attrType, SUBTYPE_BASE)
      ? attrSubType
      : SUBTYPE_BASE;
  const attrDef = registry.find(attrType, resolvedSubType);

  const node = (attrDef !== undefined
    ? attrDef.factory(attrDef.typeId, attrName)
    : new MetaAttr(new TypeId(attrType, resolvedSubType), attrName)) as MetaAttr;

  try {
    const coerced = node.coerce(attrValue);
    const desugared = node.desugar(coerced);
    node.setAttr(RESERVED_KEY_VALUE, desugared);
  } catch (err) {
    reportProblem(
      `Failed to convert attr child "${attrName}" value at ${path}: ${(err as Error).message}`,
      strict, warnings, source, path, "ERR_BAD_ATTR_VALUE",
    );
    return;
  }

  parent.setMetaAttr(node);
}
```

> The old behavior coerced child-form attrs toward the *attr node's own subtype* (the wrapper key's subType, e.g. `attr.stringarray`), not the parent's AttrSchema. The new `node.coerce`/`node.desugar` does exactly that — `StringArrayAttr.coerce` wraps the bare string, `FilterAttr.desugar` normalizes. This preserves the dual-storage semantics minus the `addChild` (attrs no longer become children).

- [ ] **Step 5: Delete the dead desugar/normalize functions**

Delete `normalizeStringArrayAttr` (lines 573-584), the filter desugar block `normalizeFilterAttr`/`desugarFilterObject`/`desugarClause` (lines 586-632) from `parser-core.ts`. Their logic now lives in the subclasses (Task 1).

- [ ] **Step 6: Run the parser tests**

Run: `cd server/typescript/packages/metadata && bun test test/parser-json.test.ts test/parser-equivalence.test.ts test/parser-yaml.test.ts`
Expected: PASS. If a YAML test asserts attrs in children, migrate it to `ownMetaAttr`/`ownAttr` the same way as Step 1.

- [ ] **Step 7: Typecheck**

Run: `cd server/typescript/packages/metadata && bunx tsc -p tsconfig.typecheck.json --noEmit`
Expected: PASS (serializer-json.ts may still reference the removed child path — fixed in Task 7; if typecheck errors are only in `serializer-json.ts`, proceed).

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/metadata/src/parser-core.ts \
  server/typescript/packages/metadata/test/parser-json.test.ts
git commit -m "feat(metadata): parser materializes all attrs into MetaAttr instances; delete inline desugar helpers"
```

---

### Task 6: Attr-schema validator dispatches `validateValue`

**Files:**
- Modify: `server/typescript/packages/metadata/src/attr-schema-validate.ts`
- Test: `server/typescript/packages/metadata/test/attr-schema-validate.test.ts` + `test/attr-object-validate.test.ts` (must keep passing)

- [ ] **Step 1: Run the existing validator tests to capture the contract**

Run: `cd server/typescript/packages/metadata && bun test test/attr-schema-validate.test.ts test/attr-object-validate.test.ts test/attr-schema.test.ts`
Expected: currently PASS (this is the behavior we must preserve through the refactor). Note the error codes: type mismatches → `ERR_BAD_ATTR_VALUE`, missing required → `ERR_MISSING_REQUIRED_ATTR`.

- [ ] **Step 2: Rewrite `validateNode` to dispatch to the instance**

In `attr-schema-validate.ts`, replace `valueMatchesType` + the `NUMERIC/STRING/OBJECT_ATTR_SUBTYPES` sets (lines 43-94) and rewire Checks 2+3. The required-present check (Check 1) is unchanged (uses `node.attrs()`). For Checks 2+3, iterate `node.ownMetaAttrs()` and call `inst.validateValue(inst.value)`:

```ts
  // --- Checks 2 + 3: declared attrs on the node are well-typed + in range ---
  for (const inst of node.ownMetaAttrs()) {
    const spec = byName.get(inst.name);
    if (spec === undefined) continue; // undeclared attr → open policy: ignore.
    const value = inst.value;
    if (value === undefined) continue;

    // Check 2: the instance validates its own value shape. When the declared
    // valueType is absent (e.g. @default), skip — any AttrValue is valid.
    if (spec.valueType !== undefined) {
      const valueErrors = inst.validateValue(value);
      if (valueErrors.length > 0) {
        for (const ve of valueErrors) {
          errors.push(new ParseError(`${nodeLabel(node)} ${ve.message}`, { code: "ERR_BAD_ATTR_VALUE" }));
        }
        continue; // type wrong → skip allowedValues
      }
    }

    // Check 3: allowedValues membership (unchanged).
    if (spec.allowedValues !== undefined && spec.allowedValues.length > 0) {
      if (!spec.allowedValues.includes(value)) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} attribute '@${inst.name}' has value ` +
              `'${String(value)}' which is not one of the allowed values: ` +
              `${spec.allowedValues.map((v) => String(v)).join(", ")}`,
            { code: "ERR_BAD_ATTR_VALUE" },
          ),
        );
      }
    }
  }
```

> **Caveat — declared valueType vs. instance subtype.** The instance's subtype was chosen by the parser from the declared `valueType` (Task 5 `materializeAttr`), so `inst.validateValue` enforces exactly the declared shape. One gap: a value the parser could NOT coerce to the declared shape (e.g. a legacy string `@filter`) is stored on a `FilterAttr` instance whose `validateValue` will reject the string — producing `ERR_BAD_ATTR_VALUE`, matching the current behavior (`test/attr-object-validate.test.ts` "rejects a string @filter value"). Confirm this test still passes in Step 4.

Delete the `valueMatchesType`, `runtimeTypeName`, and the three `*_ATTR_SUBTYPES` sets from this file (the runtime-type-name helper now lives in `meta-attr.ts`). Remove the now-unused `ATTR_SUBTYPE_*` imports.

- [ ] **Step 3: Confirm `validateDataGridFilterValues` stays a loader pass (spec section 4)**

No change to `loader/validation-passes.ts` or `loader/meta-data-loader.ts`. The cross-node `@filter`-references-sibling-field pass remains a loader pass (it reads `layout.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTER)` and the entity's sibling `@filterable` fields — inherently cross-node). `ownAttr` still returns the value, so it works unchanged.

- [ ] **Step 4: Run the validator + filter-pass tests**

Run: `cd server/typescript/packages/metadata && bun test test/attr-schema-validate.test.ts test/attr-object-validate.test.ts test/attr-schema.test.ts test/validate-grid-filter-pass.test.ts test/filterable-attrs.test.ts`
Expected: PASS — same error codes as the baseline.

- [ ] **Step 5: Typecheck**

Run: `cd server/typescript/packages/metadata && bunx tsc -p tsconfig.typecheck.json --noEmit`
Expected: PASS (modulo serializer, fixed in Task 7).

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/attr-schema-validate.ts
git commit -m "refactor(metadata): attr-schema pass dispatches MetaAttr.validateValue; delete valueMatchesType + subtype-sets"
```

---

### Task 7: Serializer always-inline (D5); package goes fully green

**Files:**
- Modify: `server/typescript/packages/metadata/src/serializer-json.ts`
- Modify: `server/typescript/packages/metadata/src/index.ts`
- Modify: `server/typescript/packages/metadata/test/serializer-json.test.ts`
- Modify: `server/typescript/packages/metadata/test/round-trip.test.ts`
- Modify: `server/typescript/packages/metadata/test/index.test.ts`

- [ ] **Step 1: Migrate the serializer tests to the always-inline rule**

In `test/serializer-json.test.ts`:
- Delete the `describe("serializeJson — attr child node preservation", …)` block (lines 498-574) and the `describe("serializeJson — inlineAttrs: false option", …)` block (lines 580-602+, through the end of that describe). These assert the removed child-node path / `inlineAttrs:false` option.
- Add a replacement test asserting the always-inline rule:

```ts
describe("serializeJson — attrs always emit inline (D5)", () => {
  it("an attr set via setAttr emits as inline @name, never a child node", () => {
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Item");
    obj.setAttr("dbTable", "item_t");
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(obj);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const objData = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;

    expect(objData[`${ATTR_PREFIX}dbTable`]).toBe("item_t");
    expect(childrenOf(objData)).toBeUndefined();
  });
});
```

> If `makeModel(TYPE_ATTR, …)` / `RESERVED_KEY_VALUE` imports become unused after the deletions, remove them (typecheck will flag).

- [ ] **Step 2: Reframe the round-trip inline-vs-child block**

In `test/round-trip.test.ts`, the block `describe("Inline-vs-child attr round-trip: …")` (lines 322-372): the assertions at lines 336-351 and 359-371 read `ownAttr(...)` and still hold (child-form input materializes to an instance; `ownAttr` returns its value). `assertModelsEqual` (line 353-357) now compares trees with zero attr-children on both sides — still consistent. No assertion in this block references attr nodes in `ownChildren()`, so **no edit is required**; just confirm it passes after the serializer change. Update the block's leading comment (lines 323-329) to state that child-form now canonicalizes to inline.

- [ ] **Step 3: Rewrite `serializeNodeInner`'s attr emission**

In `serializer-json.ts`:
- Remove `inlineAttrs` from `SerializeOptions` (and from `serializeJson`'s signature/usage); the serializer is unconditionally inline.
- Replace the attr-handling section of `serializeNodeInner` (lines 127-174). The child loop now only recurses structural children; attrs come from `ownMetaAttrs()`/`attrs()` and always emit inline:

```ts
  // In effective mode use children()/attrs() (own + inherited via super chain);
  // in own mode use ownChildren()/ownAttrs() (declared on this node only).
  const childList = effective ? model.children() : model.ownChildren();
  const attrMap = effective ? model.attrs() : model.ownAttrs();

  const serializedChildren: Record<string, unknown>[] = [];
  for (const child of childList) {
    // Attrs never appear in children(); only structural nodes recurse.
    serializedChildren.push(serializeNode(child, effective));
  }

  // Attrs ALWAYS emit inline @name (D5 — attrs have no children, one canonical form).
  for (const [attrName, attrValue] of attrMap) {
    obj[`${ATTR_PREFIX}${attrName}`] = attrValue;
  }

  if (serializedChildren.length > 0) {
    obj[RESERVED_KEY_CHILDREN] = serializedChildren;
  }
  return obj;
```

- Update `serializeNode`'s signature to drop the `inlineAttrs` param (it threads through `serializeNodeInner`). `canonicalSerialize` / `canonicalSerializeEffective` call `serializeJson`/`serializeNode` without `inlineAttrs`.
- Keep `inferAttrSubType` and its export (used by `meta-data.ts` / parser). Remove the `TYPE_ATTR`, `SUBTYPE_BASE`, and `RESERVED_KEY_VALUE` imports if they become unused (the child-node branch is gone). Keep the `ATTR_SUBTYPE_*` imports `inferAttrSubType` needs.

- [ ] **Step 4: Drop the `SerializeOptions.inlineAttrs` export fallout**

If `SerializeOptions` now only has `indent`, keep the type (codegen/tests may import it). In `index.ts` (line 121) keep `export type { SerializeOptions }`. Update `index.test.ts` (line ~188 region) to drop any `inlineAttrs` reference if present.

- [ ] **Step 5: Run the full metadata package suite — this is the green gate**

Run: `cd server/typescript/packages/metadata && bun test`
Expected: **PASS, 0 fail.** Compare against the 1008-pass baseline; the count will differ (added ~25 tests across the new files; removed 3 serializer tests). Investigate any failure — the only *expected* behavioral change is canonical output for child-form attrs (now inline), surfaced as a conformance fixture diff handled in Task 8.

- [ ] **Step 6: Conformance sub-suite (still using the OLD `attr-properties-basic` expected.json)**

Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts`
Expected: `conformance: attr-properties-basic` FAILS (canonical output is now inline `@config`, but the fixture's `expected.json` still shows the child-node form). This is the single intended fixture change — fixed in Task 8. Every OTHER conformance fixture must PASS (byte-identical). If any other fixture's canonical output changed, STOP — that is a bug in the refactor, not an intended change.

- [ ] **Step 7: Typecheck the package**

Run: `cd server/typescript/packages/metadata && bunx tsc -p tsconfig.typecheck.json --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/metadata/src/serializer-json.ts \
  server/typescript/packages/metadata/src/index.ts \
  server/typescript/packages/metadata/test/serializer-json.test.ts \
  server/typescript/packages/metadata/test/round-trip.test.ts \
  server/typescript/packages/metadata/test/index.test.ts
git commit -m "feat(metadata): serializer emits attrs always-inline (D5); remove child-node attr path + inlineAttrs option"
```

---

### Task 8: Regenerate `attr-properties-basic` expected.json (TS)

**Files:**
- Modify: `fixtures/conformance/attr-properties-basic/expected.json`

- [ ] **Step 1: Regenerate the canonical output**

Generate the new canonical serialization from the fixture input via the TS serializer and write it back:

```bash
cd server/typescript/packages/metadata && bun -e '
import { FileMetaDataLoader } from "./src/core/file-meta-data-loader.js";
import { canonicalSerialize } from "./src/serializer-json.js";
import { composeRegistry } from "./src/provider.js";
import { coreTypesProvider } from "./src/core-types.js";
import { dbProvider } from "./src/db/db-provider.js";
const dir = "../../../../fixtures/conformance/attr-properties-basic/input";
const registry = composeRegistry([coreTypesProvider, dbProvider]);
const { root } = await new FileMetaDataLoader({ registry }).loadDirectory(dir);
process.stdout.write(canonicalSerialize(root));
' > /tmp/attr-properties-basic.expected.json
cat /tmp/attr-properties-basic.expected.json
```

> Confirm the loader/serializer API names against `test/conformance/adapter.ts:loadFixture` (it uses `FileMetaDataLoader({ registry }).loadDirectory(inputDir)` + `canonicalSerialize`). If the script's import paths differ, mirror the adapter exactly.

The expected output: the `attr.properties` child node is gone, replaced by an inline `@config` object on the entity:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Subscriber",
          "@config": {
            "owner": "growth",
            "tier": "gold"
          },
          "children": [
            {
              "field.long": {
                "name": "id"
              }
            },
            {
              "identity.primary": {
                "@fields": [
                  "id"
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
```

> Exact key order is the serializer's: structural keys (`name`) first, then inline `@`-attrs (alphabetical), then `children` (per `sortAttrKeys`). Use the script's actual output verbatim — do not hand-edit — then sanity-check it matches the shape above.

- [ ] **Step 2: Write the regenerated output to the fixture**

Copy `/tmp/attr-properties-basic.expected.json` to `fixtures/conformance/attr-properties-basic/expected.json` (preserve the trailing newline `canonicalSerialize` emits).

- [ ] **Step 3: Run the TS conformance suite**

Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts`
Expected: PASS — `conformance: attr-properties-basic` now matches; all others remain byte-identical.

- [ ] **Step 4: Commit**

```bash
git add fixtures/conformance/attr-properties-basic/expected.json
git commit -m "test(conformance): regenerate attr-properties-basic to canonical inline @config (D5)"
```

---

### Task 9: Open-Closed proof test

**Files:**
- Create: `server/typescript/packages/metadata/test/open-closed-proof.test.ts`

- [ ] **Step 1: Write the proof test**

Create `server/typescript/packages/metadata/test/open-closed-proof.test.ts`. It registers a throwaway `attr.fizz` + `field.fizz` via ONLY a new class + a registration line (no central-file edit), then asserts load → coerce → validate → canonical-serialize all work:

```ts
import { describe, it, expect } from "bun:test";
import { TypeId, TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { MetaAttr, type ValueError } from "../src/meta/meta-attr.js";
import { MetaField } from "../src/meta/meta-field.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import {
  TYPE_ATTR,
  TYPE_FIELD,
  TYPE_OBJECT,
  OBJECT_SUBTYPE_ENTITY,
} from "../src/constants.js";
import { DATA_TYPE_STRING, type DataType } from "../src/data-type.js";
import type { AttrValue } from "../src/meta/meta-data.js";

// --- The ENTIRE cost of a new value-shaped attr subtype: one class. ---
const ATTR_SUBTYPE_FIZZ = "fizz";
class FizzAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_STRING;
  }
  // A 'fizz' attr value must be the literal string "fizz" or "buzz".
  override coerce(raw: unknown): AttrValue {
    return String(raw);
  }
  override validateValue(value: AttrValue): ValueError[] {
    return value === "fizz" || value === "buzz"
      ? []
      : [{ message: `attribute '@${this.name}' must be 'fizz' or 'buzz'` }];
  }
}

const FIELD_SUBTYPE_FIZZ = "fizz";
class FizzField extends MetaField {
  override get dataType(): DataType {
    return DATA_TYPE_STRING;
  }
}

function registryWithFizz(): TypeRegistry {
  const r = new TypeRegistry();
  registerCoreTypes(r);
  // --- The ENTIRE registration: two lines, no central file touched. ---
  r.register({
    typeId: new TypeId(TYPE_ATTR, ATTR_SUBTYPE_FIZZ),
    description: "throwaway fizz attr",
    factory: (id, name) => new FizzAttr(id as TypeId, name),
    childRules: [],
    attributes: [],
    dataType: DATA_TYPE_STRING,
  });
  r.register({
    typeId: new TypeId(TYPE_FIELD, FIELD_SUBTYPE_FIZZ),
    description: "throwaway fizz field",
    factory: (id, name) => new FizzField(id as TypeId, name),
    childRules: [],
    attributes: [],
    dataType: DATA_TYPE_STRING,
  });
  return r;
}

describe("Open-Closed proof: a new subtype costs one class + one registration line", () => {
  it("loads, coerces, validates, and canonically serializes attr.fizz + field.fizz", async () => {
    const registry = registryWithFizz();
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Demo",
              children: [
                { "field.fizz": { name: "label", "@fizz": "buzz" } },
                { "identity.primary": { "@fields": ["label"] } },
              ],
            },
          },
        ],
      },
    });
    const loader = new MetaDataLoader({ registry, freeze: false });
    const { root, errors } = await loader.load([new InMemorySource(doc, { id: "demo.json", format: "json" })]);
    expect(errors).toEqual([]);

    const obj = root.ownChildByTypeAndName(TYPE_OBJECT, "Demo")!;
    const field = obj.ownChildByTypeAndName(TYPE_FIELD, "label")! as FizzField;
    expect(field.subType).toBe(FIELD_SUBTYPE_FIZZ);
    expect(field.dataType).toBe(DATA_TYPE_STRING);

    // The @fizz attr materialized as a FizzAttr instance, coerced + validated.
    const fizzAttr = field.ownMetaAttr("fizz")!;
    expect(fizzAttr).toBeInstanceOf(FizzAttr);
    expect(fizzAttr.value).toBe("buzz");
    expect(fizzAttr.validateValue("buzz")).toEqual([]);
    expect(fizzAttr.validateValue("nope").length).toBeGreaterThan(0);

    // Canonical serialize emits @fizz inline and round-trips.
    const json = canonicalSerialize(root);
    expect(json).toContain('"@fizz": "buzz"');
    expect(json).toContain('"field.fizz"');
  });

  it("an invalid fizz value is rejected by the attr-schema pass without any central edit", async () => {
    // Declare @fizz on the field's schema so the attr-schema pass validates it.
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    registry.register({
      typeId: new TypeId(TYPE_ATTR, ATTR_SUBTYPE_FIZZ),
      description: "throwaway fizz attr",
      factory: (id, name) => new FizzAttr(id as TypeId, name),
      childRules: [],
      attributes: [],
      dataType: DATA_TYPE_STRING,
    });
    registry.register({
      typeId: new TypeId(TYPE_FIELD, FIELD_SUBTYPE_FIZZ),
      description: "throwaway fizz field",
      factory: (id, name) => new FizzField(id as TypeId, name),
      childRules: [],
      attributes: [
        { name: "fizz", valueType: ATTR_SUBTYPE_FIZZ, required: false, description: "fizz or buzz" },
      ],
      dataType: DATA_TYPE_STRING,
    });
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Demo",
              children: [
                { "field.fizz": { name: "label", "@fizz": "nope" } },
                { "identity.primary": { "@fields": ["label"] } },
              ],
            },
          },
        ],
      },
    });
    const loader = new MetaDataLoader({ registry, freeze: false });
    const { errors } = await loader.load([new InMemorySource(doc, { id: "demo.json", format: "json" })]);
    expect(errors.some((e) => (e as { code?: string }).code === "ERR_BAD_ATTR_VALUE")).toBe(true);
  });
});

// Documented invariant: this test required editing ZERO central files.
// No edit to data-type.ts (no DataType union change), data-converter.ts (no
// convertToDataType case), attr-schema-validate.ts (no subtype-set), or
// meta-data.ts (no AttrValue arm). The new subtype is fully described by its
// class + registration. THAT is the property this refactor exists to create.
```

> Verified during planning: `NodeConstructor` is a *local* (non-exported) type in `core-types.ts:130`, so this test does NOT import it — the factories are written inline (`factory: (id, name) => new FizzAttr(id as TypeId, name)`), which is the correct `TypeDefinition.factory` shape. `InMemorySource`'s constructor is `new InMemorySource(content: string, opts?: { id?: string; format?: MetaDataFormat })` (`loader/meta-data-source.ts:26`) — used above as `new InMemorySource(doc, { id: "demo.json", format: "json" })`.

- [ ] **Step 2: Run the proof test**

Run: `cd server/typescript/packages/metadata && bun test test/open-closed-proof.test.ts`
Expected: PASS (both cases).

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/metadata/test/open-closed-proof.test.ts
git commit -m "test(metadata): Open-Closed proof — attr.fizz + field.fizz via one class + one registration line"
```

---

# Phase 3 — Whole-monorepo TS verification + consumers

### Task 10: Whole-monorepo TS test + typecheck; fix any broken consumers

**Files:** as surfaced (codegen-ts / runtime-ts / migrate-ts / cli).

- [ ] **Step 1: Whole-monorepo test**

Run: `cd server/typescript && bun test`
Expected: PASS. Internal consumers use the value accessors (`ownAttr`/`attr`/`attrs`/`hasAttr`), whose signatures are unchanged (D4) — they should keep working. Any failure is likely a test that authored attrs-as-children or asserted attr nodes in `children()`. For each: migrate to the value accessor or `ownMetaAttr`. Do NOT change accessor signatures.

- [ ] **Step 2: Whole-monorepo typecheck**

Run: `cd server/typescript && bun run --filter '*' typecheck`
Expected: PASS. If a package imported `SerializeOptions.inlineAttrs` or the removed `convertToDataType` `DATA_TYPE_OBJECT` behavior, fix at the callsite (none expected — the grep during planning found no external `inlineAttrs` consumers and `column-mapper.ts` uses `convertToDataType` only for scalar field defaults).

- [ ] **Step 3: Commit any consumer fixes**

```bash
git add -A server/typescript client/web
git commit -m "test(ts): align consumers with materialized-attr model (value accessors unchanged)"
```

> If `git status` shows no changes here, skip the commit — the value-accessor stability (D4) means most consumers need nothing.

---

# Phase 4 — Cross-language: C# corpus parity

### Task 11: C# serializer emits attrs always-inline (corpus stays byte-identical)

**Files:**
- Modify: `server/csharp/MetaObjects/SerializerJson.cs`

**Why:** C#'s `MetaObjects.Conformance.Tests` runs the full shared `fixtures/conformance/` corpus and byte-compares each `expected.json` (`ConformanceTests.cs:131-142`, `CorpusRoot.cs`). C#'s serializer mirrors TS's OLD child-node attr emission (`SerializerJson.cs:158-200`), so once TS regenerates `attr-properties-basic/expected.json` to inline `@config`, C# `dotnet test` will FAIL on that fixture unless C# also emits child-form attrs inline. This is a serializer-only mirror; the C# parser/model are NOT being refactored (that is TS-only per the spec) — C# already stores attrs both as children and as parent attrs, so emitting them inline (and skipping the child-node emission) yields the same canonical output.

- [ ] **Step 1: Read the C# serializer attr section**

Read `server/csharp/MetaObjects/SerializerJson.cs:148-205` (the `childList`/`attrMap` walk, the `child.Type == Constants.TYPE_ATTR` child-node branch, and the inline `@`-attr loop).

- [ ] **Step 2: Make attr emission always-inline**

Mirror the TS change (Task 7 Step 3) in C#:
- In the `foreach (var child in childList)` loop, drop the `child.Type == Constants.TYPE_ATTR` special branch entirely — attrs are emitted from `attrMap` only. (C# attrs DO appear in `childList` because the C# parser `AddChild`s them at `Parser.cs:950`. To avoid double-emit and to drop the child-node form, skip attr-typed children: `if (child.Type == Constants.TYPE_ATTR) continue;` then emit nothing for them in the child loop.)
- In the inline `@`-attr loop, always write `obj.Add($"{Constants.ATTR_PREFIX}{attrName}", AttrValueToJsonNode(attrValue));` (remove the `inlineAttrs` conditional / the child-node `else` branch).
- Remove the now-dead `inlineAttrs` parameter threading if the C# `SerializeJson` exposes it (match whatever the C# `Serialize` entry points use; if `inlineAttrs` is internal-only, simplify).

> The C# `emittedAsChild` set and `InferAttrSubType` child-node usage become dead — remove them. Keep `InferAttrSubType` only if still referenced; otherwise delete it too.

- [ ] **Step 3: Run C# conformance**

Run: `cd server/csharp && dotnet test`
Expected: PASS — the full corpus matches, including the regenerated `attr-properties-basic` (now inline `@config`). All other fixtures unchanged. The ledger (`conformance-expected-failures.json`) stays `[]`.

- [ ] **Step 4: Commit**

```bash
git add server/csharp/MetaObjects/SerializerJson.cs
git commit -m "feat(csharp): canonical serializer emits attrs always-inline (D5 corpus parity)"
```

---

# Phase 5 — Cross-language: Java verify-only

### Task 12: Confirm Java metadata tests stay green

**Files:** none (verification).

**Why:** Java is already fully instance-based (`MetaAttribute<T>` self-registering) and does NOT read the regenerated `attr-properties-basic/expected.json` — its canonical tests build the tree in-memory (`CanonicalJsonSerializerTest.java`) and it only reads `loader-basic-empty-package` + `smoke-empty-metadata` from the shared corpus (`CanonicalJsonParserTest.java:450,486`), neither of which changes. So Java needs no code change; this task is a guardrail.

- [ ] **Step 1: Run the Java metadata module tests**

Run: `cd server/java && mvn -q -pl metadata test`
Expected: PASS. If a Java test fails, it indicates an unintended corpus change beyond `attr-properties-basic` — STOP and diff `git status fixtures/conformance/` to find which other fixture regenerated (it should be ONLY `attr-properties-basic`).

- [ ] **Step 2: No commit** (verification only). If Java was already green, record the result in the task notes and proceed.

---

# Phase 6 — Final corpus + monorepo verification

### Task 13: Final full verification

**Files:** none (verification).

- [ ] **Step 1: Confirm exactly one fixture changed**

Run: `git diff --stat origin/main -- fixtures/conformance/`
Expected: the ONLY changed fixture file is `fixtures/conformance/attr-properties-basic/expected.json` (plus the pre-existing staged `ERROR-CODES.json` change if relevant — confirm it is unrelated). Any other fixture diff is a refactor bug.

- [ ] **Step 2: Full TS suite**

Run: `cd server/typescript && bun test`
Expected: PASS, 0 fail.

- [ ] **Step 3: Full TS typecheck**

Run: `cd server/typescript && bun run --filter '*' typecheck`
Expected: PASS.

- [ ] **Step 4: C# + Java**

Run: `cd server/csharp && dotnet test`  → Expected: PASS.
Run: `cd server/java && mvn -q -pl metadata test`  → Expected: PASS.

- [ ] **Step 5: downstream-consumer (if reachable)**

Search for downstream-consumer in this repo: `git ls-files | grep -i "downstream-consumer" | head`. If present, run its load/gen check (e.g. `meta gen --dry-run` in its dir) and confirm no `ERR_*` regressions. If NOT in this repo (it is an external adopter per D7), note "downstream-consumer not present in this checkout — fix in its own repo after this lands; the value-accessor stability (D4) means it should need no change."

- [ ] **Step 6: Final commit (if any stragglers)**

```bash
git add -A
git commit -m "chore(metadata): finalize Open-Closed typed-node refactor"
```

---

## Self-Review

**Spec coverage check:**
- D1 (attrs AND fields) → Tasks 1, 2 (both gain `dataType`/`coerce`; field also `validateValue`-eligible). ✓
- D2 (full materialization; no flat raw-value map) → Task 4 (`_attrNodes` of `MetaAttr` instances; `_attrs` deleted). ✓
- D3 (behavior on the class, polymorphic; registry factory maps subtype→class) → Tasks 1, 3 (`ATTR_CLASS_MAP` + `attrClassFor`). ✓
- D4 (keep value-accessor API; add `ownMetaAttr`/`ownMetaAttrs`) → Task 4. ✓
- D5 (canonical: attrs always inline; remove child-node emission; regenerate `attr-properties-basic`) → Tasks 7, 8 (TS), 11 (C#). ✓
- D6 (straight to end state; delete `_attrs` + legacy `_effectiveAttrs` merge; no shims) → Task 4 (delete raw map + rewrite `_effectiveAttrs` over instances). ✓
- D7 (consumers; downstream-consumer) → Tasks 10, 13 Step 5. ✓
- Collapse central code: delete `ATTR_DATA_TYPE`/`FIELD_DATA_TYPE`/`dataTypeFor` → Task 3; `convertToDataType` OBJECT arm → folded into subclass `coerce` (Task 1) + dropped in Task 5/Task 3 cleanup; `valueMatchesType` + subtype-sets → Task 6; `normalizeStringArrayAttr`/`normalizeFilterAttr` → Tasks 1 (moved to subclasses) + 5 (deleted from parser). ✓
- Parser is sole owner of inline-vs-child → Task 5 (both forms materialize via `materializeAttr`/`parseAttrChild`). ✓
- Cross-node loader passes stay → Task 6 Step 3 (`validateDataGridFilterValues` untouched). ✓
- Open-Closed proof test → Task 9. ✓
- Whole-monorepo green + C# + Java green; corpus byte-identical except `attr-properties-basic` → Tasks 10, 11, 12, 13. ✓

**Placeholder scan:** No "TBD"/"implement later". Every code step shows real code or the exact transformation of cited existing code with line numbers. `InMemorySource`'s ctor (`(content, { id, format })`), `NodeConstructor`'s locality, `FileMetaDataLoader.loadDirectory(dir)` + `canonicalSerialize` (the adapter's API), and the verified 1008-pass baseline were all confirmed against source during planning. The two remaining "confirm" notes (the ESM init-order cycle fallback to a leaf `attr-class-map.ts` module; whether a non-metadata package authored attrs-as-children) are genuine runtime/integration unknowns that only execution can settle — each carries a concrete detector and fallback.

**Type/signature consistency:**
- `ValueError` (defined in `meta-attr.ts`, Task 1) is the return type of every `validateValue` and is consumed by the attr-schema pass (Task 6). ✓
- `runtimeTypeName` exported from `meta-attr.ts` (Task 1) and used by the subclasses; the old copy in `attr-schema-validate.ts` is deleted (Task 6). ✓
- `ownMetaAttr(name): MetaAttr | undefined` / `ownMetaAttrs(): readonly MetaAttr[]` defined in Task 4, consumed in Tasks 5 (parser test), 6 (validator), 9 (proof). ✓
- `setMetaAttr(node: MetaAttr)` (Task 4) is the parser's instance-attach path (Task 5). ✓
- `attrClassFor(subType): NodeConstructor` (Task 4, exported from `core-types.ts`) consumed by `meta-data.ts:setAttr`. ✓
- `inferAttrSubType` stays exported (Task 7) and is used by `meta-data.ts:setAttr` (undeclared) and `parser-core.ts:inferUndeclaredAttrSubType` (Task 5). ✓
- `coerce`/`desugar` order is consistent: parser does `coerce` then `desugar` (Task 5) matching the base/subclass contract (Task 1). ✓
- `TypeDefinition.dataType` is preserved (Task 3 reasoning) so `registry.find(...).dataType` (parser, `data-type.test.ts`) keeps working. ✓

**Open verification items for the executor (cheap, flagged inline):**
- ESM init-order cycle on `attrClassFor`/`MetaAttr` between `meta-data.ts` and `core-types.ts` — Task 4 Step 3/6 carries the leaf-module fallback (`src/attr-class-map.ts`).
- Whether any non-metadata TS package authored attrs-as-children — Task 10 (the whole-suite run is the detector; planning grep found only value-accessor consumers).
