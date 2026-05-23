# ADR-0002 — Open-Closed typed nodes (subtype behavior on the class)

**Status:** Accepted — 2026-05-23
**Applies to:** all language ports (TS, Java, Python, C#)
**Related:** ADR-0003 (constants colocation), ADR-0004 (provider-based registration);
`docs/superpowers/specs/2026-05-22-typed-node-open-closed-design.md` (TS feature design);
`spec/conformance-tests.md`; `spec/cross-language-porting-guide.md`

## Context

A metamodel framework grows by adding **types** — new field subtypes, new attribute
subtypes, new validators. The cost of adding one is the single most important
extensibility metric for the project, because every metamodel feature multiplies across
every language port.

An earlier shape (the original TS rewrite, faithfully mirrored into C#) optimized for the
*opposite* axis — adding new *operations* cheaply at the cost of adding new *types*. It
expressed each subtype's value behavior through **central dispatch tables**:

- value type → a closed `AttrValue` / datatype **union**
- subtype → datatype → central `ATTR_DATA_TYPE` / `FIELD_DATA_TYPE` **maps**
- value coercion → a central `convertToDataType` **switch**
- normalization / desugar → the central **parser**
- value validation → hardcoded subtype-**sets** in a central validator

Adding one value-shaped attribute subtype therefore meant editing many central files —
measured on the `attr.filter` + `attr.properties` feature: **TS = 11 files, C# = 9, Java =
3**. This is the classic *expression problem*. It is systemic (fields have the same shape)
and it taxes every port.

The deeper root cause in the TS rewrite: inline `@`-attributes were stored as raw values in
a flat per-node map and **never materialized as attribute instances**, so there was no
per-attribute object to carry behavior. Java never made this mistake — its canonical parser
materializes **every** attribute (inline included) as a `MetaAttribute` instance and
dispatches polymorphically. "Inline vs child" is a **serialization concern owned by the
parser**, not a property of the constructed model.

## Decision

**Subtype behavior lives on the node class, polymorphically. Adding a field or attribute
subtype is one new class plus one registration line, with zero edits to any central
dispatch table.**

Concretely, the durable cross-language contract is:

1. **Behavior on the class.** Each node base (`MetaAttr`, `MetaField`) owns the value
   operations — `dataType`, `coerce`, `validateValue`, `desugar` — resolved by subtype.
   Subclasses override only what differs (e.g. a filter-attr's object desugar, a
   string-array attr's bare-string→array coercion). No central datatype map, coercion
   switch, value union, or validator subtype-set.
2. **Full materialization.** Attributes are first-class node instances in the constructed
   model, never flat raw values. Inline `@name` syntax is **parse-time sugar only**; the
   parser is the sole owner of inline-vs-child syntax.
3. **One canonical output form.** Attributes have no children, so they always serialize
   inline as `@name`. There is no provenance flag on the model.
4. **The registry binds `(type, subType)` → class.** The factory instantiates the right
   class; parser and validator dispatch to the instance.
5. **Genuinely-central passes stay central.** A cross-node loader pass (e.g. validating a
   dataGrid `@filter` against *sibling* filterable fields) cannot live on a single node and
   correctly remains a loader pass. This is the only legitimately-central category.

**Executable definition of done (every port).** A test registers a throwaway `attr.fizz` +
`field.fizz` subtype via **only** a new class and a single registration line, then asserts
load → coerce → validate → canonical-serialize all work, **and** that no central file (a
datatype map, a converter switch, a validator set, a value union) was touched. This
"Open-Closed proof" is the regression guard for the property this ADR exists to create.

## Consequences

**Positive**
- Adding a metamodel subtype costs ~1 class per language instead of ~9–11 central edits.
- Behavior is local and testable per subtype; no central file accretes subtype knowledge.
- TS, Java, and (newly) Python converge structurally, so a feature ports at roughly equal
  cost everywhere instead of multiplying central-edit surgery.
- Wire-neutral: the canonical serialized output is unchanged by *where* behavior lives.

**Negative / costs**
- The core node base (storage + value accessors) is rewritten to hold attribute
  *instances*. This is a central, one-time investment per port; the conformance corpus and
  the Open-Closed proof test are the guardrails.
- Effective-attr / overlay-merge semantics must be reimplemented over instances and match
  last-writer-wins exactly. The extends/overlay corpus fixtures pin this.

## Alternatives considered (rejected)

1. **Central dispatch tables (the original shape).** Cheap new operations, expensive new
   types — backwards for a metamodel framework. Rejected; this ADR exists to undo it.
2. **Single class + a giant switch.** Same expression-problem failure, just relocated.
3. **Code generation of the dispatch tables.** Adds a build step and still centralizes type
   knowledge; the polymorphic class already solves it without generation.

## Realization status

- **Java** — always instance-based (`MetaAttribute<T>`, self-registering). Reference shape.
- **TS** — refactored onto this model
  (`docs/superpowers/specs/2026-05-22-typed-node-open-closed-design.md`).
- **C#** — **stale**: still on the old central-dispatch shape (shipped at v0.3 parity,
  predates the refactor). To be migrated when C# is next touched. Do **not** treat the
  current C# loader as the reference for new ports — see `spec/cross-language-porting-guide.md`.
- **Python** — adopting this model from the start (loader + conformance milestone), with the
  Open-Closed proof test as an explicit deliverable.

## Conformance note

Canonical serialized output is identical regardless of where subtype behavior lives — the
corpus tests *output*, not implementation. The one deliberate exception in the refactor was
`attr-properties-basic`, which regenerates from child-form to inline `@config` (a
deterministic canonical change, regenerated for all languages). Any other canonical diff is
a bug.
