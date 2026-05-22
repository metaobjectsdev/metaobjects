# Design: Open-Closed typed nodes — attribute & field value behavior on the class

**Date:** 2026-05-22
**Status:** Approved (design)
**Author:** Doug Mealing (with Claude)
**Branch:** `feat/typed-node-open-closed` (off `main` @ `1cfdfbf`, which includes the attr.filter/properties feature)

## Problem

Adding a new value-shaped attribute subtype to the TS reference is shotgun surgery across central
files. Measured on the just-shipped `attr.filter` + `attr.properties` feature: **TS = 11 source
files, C# = 9 (mirrored TS), Java = 3** (one self-registering `FilterAttribute` + a registration
line + a serializer branch). Java stayed cheap because it kept the **polymorphic, self-registering
`MetaAttribute<T>`** pattern; the TS rewrite replaced it with **a single `MetaAttr`/`MetaField`
class dispatched through central tables**:

- value type → the closed `AttrValue` union (`meta/meta-data.ts`)
- value coercion → the `convertToDataType` switch (`data-converter.ts`)
- normalization/desugar → the central parser (`parser-core.ts`)
- value validation → hardcoded subtype-sets in `attr-schema-validate.ts`
- subtype → datatype → the `ATTR_DATA_TYPE` / `FIELD_DATA_TYPE` maps (`core-types.ts`)

This is the expression problem: TS optimized for adding new *operations* cheaply at the cost of
adding new *types* — the opposite of what a metamodel framework wants. It is systemic (`MetaField`
has the same shape) and it multiplies across every language port.

**Root cause, deeper than the central switches:** in TS, inline `@`-attributes are stored as raw
values in the owning node's flat `_attrs: Map<string, AttrValue>` and are **never materialized as
`MetaAttr` instances** (only the rarer child-form `{ "attr.*": {...} }` creates instances). So there
is no per-attribute object to carry behavior. In Java, the canonical parser materializes **every**
attribute — inline included — as a `MetaAttribute` instance and dispatches `setValueAsString`
polymorphically. "Inline vs child" is a **serialization concern owned by the parser**, not a property
of the constructed model. Baking it into the TS model was the original mistake.

## Goal

Restore Open-Closed for typed nodes: **adding an attribute or field subtype is one class + one
registration line, with zero edits to any central file.** The model represents every attribute
uniformly as a `MetaAttr` instance; the parser is the sole owner of inline-vs-child syntax. TS
converges structurally onto Java (and what C# mirrors), so future metamodel features cost ~1 class
per language instead of ~9–11 central edits.

## Decisions

- **D1 — Scope: attributes AND fields.** Both use the single-class + central-dispatch pattern; fix
  both. (Fields are already instances, so their share is mostly moving datatype/value behavior onto
  the class.)
- **D2 — Full materialization.** Attributes become `MetaAttr` instances in the model. Inline
  `@`-syntax is parse-time sugar only. No flat raw-value attr map in the constructed model.
- **D3 — Behavior on the class, polymorphic.** `MetaAttr`/`MetaField` own `dataType` / `coerce` /
  `validateValue` / `desugar`, resolving by subtype; subclasses override (`FilterAttr`,
  `StringArrayAttr`, `PropertiesAttr`). The registry `factory` maps each `(type, subType)` to its
  class. Parser and validator dispatch to the instance.
- **D4 — Keep the value-accessor API; reimplement over instances.** `ownAttr`/`attr`/`attrs`/
  `ownAttrs`/`hasAttr`/`setAttr` stay (they are the correct convenience layer, same as Java's
  `MetaData`), reimplemented to read/write through `MetaAttr` instances. Add `ownMetaAttr(name)` /
  `ownMetaAttrs()` for callers needing the instance.
- **D5 — Canonical rule: attributes always emit inline `@name`.** Attributes have no children, so
  there is one canonical output form. No provenance flag on the model. The single child-form fixture
  in the corpus (`attr-properties-basic`) regenerates to inline; all other canonical output stays
  byte-identical.
- **D6 — Straight to the end state. No backwards compatibility.** Delete the `_attrs` raw map and the
  legacy `_effectiveAttrs` raw-map merge outright. No delegation shims, no dual-path, no compat flags.
  (Per CLAUDE.md "No backwards-compat hacks.")
- **D7 — Consumers.** No external TS adopters except downstream-consumer; fix it after the change. Internal
  monorepo consumers keep working through the reimplemented value accessors; update any that break.

## Design

### 1. Model & storage (`meta/meta-data.ts`)

Replace `private _attrs: Map<string, AttrValue>` with a name-indexed collection of `MetaAttr`
instances (e.g. `private _attrNodes: Map<string, MetaAttr>`, insertion-ordered). Attributes are owned
nodes (parented), not flat values.

- `setAttr(name, value)`: resolve the attr's class via the registry (declared subtype) or infer it
  via the existing `inferAttrSubType` (undeclared); create/update the `MetaAttr` instance; the
  instance coerces/validates its own value.
- `ownAttr(name)` → `this._attrNodes.get(name)?.value`.
- `attrs()` / `ownAttrs()` → value maps built from instances (effective resolution walks the super
  chain collecting instances by name, own wins). The legacy `_effectiveAttrs` raw-map implementation
  is deleted and replaced by instance-based effective resolution.
- New: `ownMetaAttr(name): MetaAttr | undefined`, `ownMetaAttrs(): readonly MetaAttr[]`.

### 2. Behavior hierarchy

`MetaAttr` (base) gains:
- `get dataType(): DataType` — resolves by `this.subType` (replaces `ATTR_DATA_TYPE`).
- `coerce(raw: unknown): AttrValue` — replaces the `convertToDataType` body for the base subtypes.
- `validateValue(value: AttrValue): ValueError[]` — replaces `valueMatchesType` + the subtype-sets.
- `desugar(value: AttrValue): AttrValue` — default identity.

Subclasses override only what differs:
- `FilterAttr` — object validation + the filter desugar (scalar→eq, array→in, null→isNull, or/and
  recurse), moved out of `parser-core.ts`.
- `StringArrayAttr` — bare-string→one-element-array coercion, moved out of `normalizeStringArrayAttr`.
- `PropertiesAttr` — object/string-bag validation.

`MetaField` (base) gains `get dataType()` (replaces `FIELD_DATA_TYPE`) and any field value behavior;
subclass only where a field's *value* handling diverges (none required today — `currency` is a
`long` carrying extra metadata attrs, not a distinct value shape).

The registry `TypeDefinition.factory` already creates a node per `(type, subType)`; register the
specific class for each subtype so the right class is instantiated.

### 3. What collapses centrally (deleted)

- `ATTR_DATA_TYPE`, `FIELD_DATA_TYPE` maps and `dataTypeFor` (`core-types.ts`).
- `convertToDataType` datatype switch (`data-converter.ts`) — folded into per-class `coerce`. (The
  `toAttrValue` undeclared-value path likewise becomes the base/inferred class's `coerce`.)
- `valueMatchesType` + `STRING/NUMERIC/OBJECT_ATTR_SUBTYPES` sets (`attr-schema-validate.ts`) —
  folded into per-class `validateValue`. The attr-schema pass iterates materialized instances and
  calls `validateValue`.
- `normalizeStringArrayAttr`, `normalizeFilterAttr` (`parser-core.ts`) — folded into the relevant
  subclasses.

### 4. What stays central (correctly)

Cross-node loader passes — e.g. `validateDataGridFilterValues` (a `@filter` references *sibling*
filterable fields) — cannot live on a single node; they remain loader passes. This is the only
legitimately-central category.

### 5. Parser & serializer

- **Parser** (`parser-core.ts`) becomes the sole owner of inline-vs-child syntax: inline `@`-keys and
  child-form `attr.*` both materialize into `MetaAttr` instances (right class via registry / inferred
  subtype), and the instance coerces+desugars its own value. The central coercion/normalization code
  is gone.
- **Serializer** (`serializer-json.ts`): canonical rule D5 — attributes always emit inline `@name`
  (attrs have no children). Remove the child-node attr emission path from canonical output. Reading is
  from instances via `ownMetaAttrs()`.
- **Overlay/merge + super chain**: merge `MetaAttr` instances by name (own/last-writer wins) — same
  semantics as the current raw-map merge, now over instances.

### 6. Cross-language

Java is already fully instance-based; C# mirrors it. This makes TS structurally identical. The
conformance corpus is the guardrail: canonical output stays byte-identical except `attr-properties-basic`,
which regenerates from child-form to inline `@config` (a deliberate, deterministic canonical change),
regenerated for all languages.

### 7. Open-Closed proof (executable definition of done)

A test registers a throwaway `attr.fizz` + `field.fizz` subtype via **only** a new class + a single
registration line, then asserts load → coerce → validate → canonical-serialize all work, with an
assertion that no central file (datatype map, converter switch, validator set, value union) was
touched. This is the regression guard for the property the refactor exists to create.

## Migration (direct to end state)

No incremental scaffolding, no delegation shims, no compat. Ordered for reviewable commits, but each
lands real end-state code:

1. Add the behavior methods (`dataType`/`coerce`/`validateValue`/`desugar`) to `MetaAttr`/`MetaField`
   bases + the `FilterAttr`/`StringArrayAttr`/`PropertiesAttr` subclasses; register classes in the
   factory.
2. Convert `MetaData` storage to `MetaAttr` instances; reimplement `setAttr`/`ownAttr`/`attrs`/etc.
   over instances; add `ownMetaAttr`; delete `_attrs` raw map and legacy `_effectiveAttrs`.
3. Rewrite the parser to materialize all attrs into instances; delete the central
   coercion/normalization calls.
4. Rewrite the attr-schema pass to dispatch `validateValue`; delete `valueMatchesType` + subtype-sets.
5. Update the serializer to the always-inline canonical rule; delete central datatype maps.
6. Regenerate `attr-properties-basic` expected output (TS + C#); fix any internal monorepo consumers;
   fix downstream-consumer.

**Verification (not optional):** full TS suite + whole-monorepo typecheck green; conformance
byte-identical except the one regenerated fixture; C# `dotnet test` + Java metadata tests green; the
Open-Closed proof test passes.

## Out of scope

- An instance-first public API migration beyond keeping the value accessors (they are the intended
  interface). `ownMetaAttr` is added but consumers aren't forced onto it.
- Codegen/runtime behavior changes — unaffected via the value accessors.
- Python.
- Promoting the per-subtype-class pattern to other node kinds beyond attr/field (identity, relationship,
  origin, layout) — those don't carry coerced scalar values; revisit only if needed.

## Risks

- **Blast radius in core `MetaData`.** Storage + accessor rewrite is central. Mitigation: the value
  accessors keep their signatures; the test suite + byte-identical conformance are the guardrail.
- **Effective-attr / merge semantics drift.** Instance-based super-chain + overlay merge must match
  the current last-writer-wins behavior exactly. Mitigation: existing extends/overlay tests + the
  conformance corpus.
- **Canonical output drift.** Only `attr-properties-basic` should change. Mitigation: diff the full
  corpus canonical output; any other change is a bug.
