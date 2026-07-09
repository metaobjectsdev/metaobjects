# Cross-Language Porting Guide

Durable, target-agnostic knowledge for porting the MetaObjects loader (and, later, runtime
and codegen) to a new language. This is the deep companion to the `cross-language-porting`
skill: the skill is the short workflow; this is the accumulated *how* — the pipeline, the
extensibility model, and the subtle behaviors that a from-spec re-derivation gets wrong.

> **Read this before porting.** First-principles reasoning from the spec produces subtly
> wrong behavior. The spec says *what*; the reference implementations capture *how*,
> including edge cases and error handling. Study them.

## 1. The Tier taxonomy — what you may change

Every decision in a port falls into one of three tiers:

- **Tier 1 — Invariant.** Metamodel vocabulary (type/subtype names, attr names, separators),
  the canonical wire format, the provider/registry *contract*, observable load semantics,
  and **error codes**. Never change these. The conformance corpus is their oracle.
- **Tier 2 — Idiomatic.** API naming, null representation, collection types, sync/async,
  error-handling style, provider *discovery mechanism*, build tooling. Make these native to
  the target language.
- **Tier 3 — Free.** Internal mechanism, file layout, performance. Your call.

When a fixture goes red, ask **"should it match?"** before "how do I make it match." It may
be a stale or wrong golden — escalate it; do not edit a fixture to match your port. You are
the translator, not the alignment authority.

## 2. Which implementation to study — and a warning

| Implementation | Status as a reference | Use it for |
|---|---|---|
| **TypeScript** | Current, published. Reflects all 2026-05 refactors. | The canonical loader pipeline, serializer, the Open-Closed model (post-refactor). |
| **Java** | Current, active port (H3). Always used the Open-Closed / colocation / provider-SPI shape. | The reference for the extensibility model and registry-level inheritance. |
| **C#** | **STALE.** Shipped at v0.3 parity; **predates** the 2026-05-21/22 refactors. | The *conformance-runner algorithm* and fixture-harness shape only. **Not** the loader internals. |

> ⚠️ **Do not mirror C#'s loader internals.** C# still carries the pre-refactor
> anti-patterns this project deliberately removed: a god `Constants.cs` (see ADR-0003), and
> central dispatch tables for attr/field value behavior (see ADR-0002). Mirroring C# ports
> those anti-patterns into a new language. C#'s conformance *harness* (fixture discovery,
> runner check-ordering, expected-failures ledger) is fine to mirror — it is the loader
> *internals* that are stale. When C# is next touched it should be migrated forward.

**Rule of thumb:** for *what the loader does* (pipeline, semantics, errors) read **TS**; for
*how to structure types for extensibility* read **Java**; for *how to run the corpus* read
any of TS/C#.

## 3. The loader pipeline (canonical stages)

A directory of metadata JSON files becomes a frozen, canonical metadata tree plus error and
warning lists, through these ordered stages. Mirror the order; the mechanism is yours.

1. **File discovery.** Glob `*.json` in the input directory (YAML is optional and currently
   unexercised by the corpus), sorted **deterministically (ordinal)**. Order matters for
   reproducible parsing and for overlay merge.
2. **Parse** each source's JSON into a node tree with **deferred super-resolution enabled** —
   an `extends` reference is saved as a raw string, not resolved yet. Strip a leading UTF-8
   BOM. Malformed JSON → `ERR_MALFORMED_JSON` (in non-strict mode, accumulate rather than
   throw).
3. **Multi-source overlay merge** into one accumulating root. Same `package` + same object
   `name` across files → merged: **last-writer-wins** on attribute conflicts, structural
   children **accumulate** (append, not re-sort). An `@overlay` node with no existing target
   → `ERR_OVERLAY_NO_TARGET`.
4. **Deferred super-resolution** over the *fully merged* tree (so a source can extend a base
   defined in a later file). Package-aware reference forms: bare `Name` (context package,
   then root), absolute `::pkg::Name`, relative `..::pkg::Name` (walk up N package levels).
   Unresolved → `ERR_UNRESOLVED_SUPER`. Idempotent walk; skip already-resolved nodes.
5. **Validation passes**, in this order:
   1. **Subtype rules** — a value object must not carry a primary identity (error
      `ERR_SUBTYPE_RULE_VIOLATION`); a concrete (non-abstract) entity should have a primary
      identity (**warning**).
   2. **DataGrid sort field** — a layout `@defaultSortField` must name a real field
      (`ERR_BAD_DEFAULT_SORT_FIELD`).
   3. **Filterable-without-index** — a `@filterable` field not in any identity and not
      `@db.indexed` → **warning** (drift detection).
   4. **Origin paths** — `passthrough`/`aggregate` `@from`/`@of` must resolve to
      `Entity.field`; `@via` must hop correctly through relationships
      (`ERR_INVALID_ORIGIN`). A `passthrough` field must also be **type-preserving**:
      its declared `field.<subType>` and array-ness must match the resolved source field
      (nullability is not judged — an outer-join view legitimately widens `NOT NULL` →
      nullable). A divergence fails with `ERR_PASSTHROUGH_TYPE_MISMATCH` unless the
      `origin.passthrough` carries `@convert: true` (an acknowledgement only — it does
      not generate a cast). This host-agnostic check covers projections, entities,
      values, and stored-proc parameter refs (it generalizes/retires the FR-015
      `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH`).
   5. **Attribute schema** — declared attrs must match their declared value type and
      allowed-values; required attrs must be present (effective: own + inherited). Undeclared
      attrs are **not** rejected (open policy). Errors `ERR_MISSING_REQUIRED_ATTR`,
      `ERR_BAD_ATTR_VALUE`.
   6. **DataGrid filter values** — a dataGrid `@filter` must reference a `@filterable`
      sibling field and use an operator allowed for that field's subtype
      (`ERR_BAD_ATTR_FILTER`). This is the canonical *legitimately-central* cross-node pass.
6. **Freeze** the tree recursively (immutable thereafter; enables per-node read caching).
7. **Return** the root + errors + warnings.

## 4. The extensibility model (ADR-0002/0003/0004 in practice)

This is the part most likely to be ported wrong. The binding contract: **adding a metamodel
subtype is one class + one registration line, with zero edits to any central file.**

- **Constants colocation (ADR-0003).** No god constants file. Type/subtype/attr-name
  constants live with the node class / concern module that owns them, grouped by metamodel
  layer (core / persistence / presentation / shared). A package-root barrel may re-export for
  convenient imports, but the colocated definition is the source of truth.
- **Behavior on the class (ADR-0002).** Node bases (`MetaAttr`, `MetaField`) own the value
  operations — `dataType`, `coerce`, `validateValue`, `desugar` — resolved by subtype;
  subclasses override only what differs. There is **no** central datatype map, coercion
  switch, value union, or hardcoded validator subtype-set. Attributes are **fully
  materialized as instances**; inline `@name` vs child-form is a **parser** concern; the
  canonical output form is always inline `@name`.
- **Provider registration (ADR-0004).** Types register via composable providers
  (`id`, `dependencies`, `registerTypes(registry)`); `composeRegistry` topo-sorts. The seam
  exists from day one even with a single core provider — *the seam is the contract.*
  Registry-level `inheritsFrom(type, subType)` lets a subtype avoid re-declaring base attrs.
- **The Open-Closed proof test** is the executable definition of done: register a throwaway
  `attr.fizz` + `field.fizz` via only a class + a registration line, assert
  load→coerce→validate→serialize all work, and that no central file was touched. Every port
  ships this test.

## 5. Subtle behaviors a from-spec re-derivation gets wrong

These are the *how* details that are not in the spec and that broke (or would have broken)
real ports:

- **Inline-vs-child attrs is a serialization concern, not a model property.** Construct one
  uniform attribute-instance model; let the parser own the two input syntaxes and the
  serializer emit the one canonical form (inline `@name`). Baking "inline" into the model
  (a flat raw-value map) is the original mistake ADR-0002 unwinds.
- **Deferred super-resolution is a second pass over the merged tree**, not inline during
  parse — otherwise cross-file `extends` (a child extending a base defined in a
  later-sorted file) fails.
- **`@fields` desugaring.** Authoring may write `"@fields": "id"` (scalar) or
  `"@fields": ["id"]` (array); the canonical form is always the array. Desugar at parse time;
  validation must still handle both forms defensively.
- **Whole-number doubles serialize as integers.** An attribute value of `3.0` emits as `3`,
  mirroring `JSON.stringify`. Match this or canonical bytes diverge.
- **Package inheritance is positional.** Fields *inside* an object do not inherit a package
  (simple names); nodes outside an object inherit their parent's package; validators inside a
  field inherit the field's package. Get this wrong and FQNs — hence super-resolution — break.
- **Errors are compared by stable CODE, not message text.** The corpus compares the *set of
  error codes* (sorted). Message wording is Tier-2; the `ErrorCode` vocabulary is Tier-1 and
  must match `fixtures/conformance/ERROR-CODES.json` exactly.
- **Canonical serializer key order is fixed:** `name`, `package`, `extends`, `abstract`,
  `overlay`, `isArray`, then `@`-attrs **alphabetically**, then `children` in **declaration
  order** (never alphabetized). 2-space indent, single trailing newline. `isArray` is a
  structural key, not an `@`-attr.
- **`isArray` is structural and non-inherited**, unlike attributes.
- **Self-registration depends on the subtype module being imported.** Each language handles
  this idiomatically (Java SPI; TS side-effect imports; Python concern-package `__init__`).
  Forgetting to import a concern silently drops its subtypes — a classic porting bug.

## 6. The conformance corpus is the oracle

The shared corpus at `fixtures/conformance/` (see `spec/conformance-tests.md` for the fixture
format and canonical serializer contract) is the single source of truth for loader behavior.

- **Runner algorithm** (mirror it): for each fixture, load `input/`; if `expected-errors.json`
  is present, assert the sorted error-code set matches; else assert no errors, then assert
  the canonical serialization deep-equals `expected.json`; assert the sorted warning set
  matches `expected-warnings.json` (or empty). A single `script.json` fixture exercises a
  navigate/invoke capability check.
- **The expected-failures ledger.** A port-local ledger lists fixtures known to fail. The
  classifier: listed+fail → `known-gap` (CI green); listed+pass → `fixed-but-listed` (remove
  it); unlisted+fail → `fail` (CI red); unlisted+pass → `pass`. **Discipline:** seed the
  ledger with every fixture as a known-gap so CI is green from commit #1, then remove each as
  its slice lands. Update the ledger honestly — never silently regenerate a golden to turn a
  check green.
- A metamodel feature **is not done** until its conformance fixtures exist and pass in the
  reference. Adding new metamodel behavior means adding a fixture so every port verifies it.

## 7. Per-language idiom cheat-sheet (Tier-2)

| Concern | TS | Java | Python | C# (target) |
|---|---|---|---|---|
| Subtype self-registration | side-effect import into a class map | static `registerTypes` + SPI | decorator onto a domain provider | module initializer |
| Provider discovery | explicit `composeRegistry([...])` | `ServiceLoader` (SPI) | explicit `compose_registry([...])`; entry-points later | assembly module initializer |
| Null / absent | `undefined` | `null` / `Optional` | `None` | nullable refs |
| Test runner | `bun test` | JUnit | `pytest` (parametrized over fixtures) | `dotnet test` (xUnit Theory) |
| Constants | per-concern modules + barrel | constants on type class | per-concern modules + package barrel | (migrate off `Constants.cs`) |

## 8. New-port checklist

1. Confirm the behavior you're porting has conformance fixtures (write them in the reference
   first if not).
2. Stand up the conformance harness + a ledger seeded with all fixtures as known-gaps; get CI
   green.
3. Build the registry + provider seam (ADR-0004) and the node bases with behavior on the
   class (ADR-0002), constants colocated (ADR-0003) — even before most subtypes exist.
4. Implement the pipeline in vertical slices, removing ledger entries as fixtures pass.
5. Ship the Open-Closed proof test.
6. Record any genuinely new cross-language decision as an ADR; record any port-specific
   surprise back into this guide.
