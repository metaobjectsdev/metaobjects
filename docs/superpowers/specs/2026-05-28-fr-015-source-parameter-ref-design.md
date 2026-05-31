# FR-015 — `@parameterRef` on `source.rdb` for typed callable inputs

**Status:** Design (ready for implementation plan)
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python).
**Supersedes:** the new `parameter.<subtype>` node-type proposal in `/tmp/metaobjects-proposals.md` (rejected during design review as overfitting a generic concept that the existing `object.value` + `@payloadRef` pattern from FR-004 already solves).
**Related ADRs:** [ADR-0002](../../../spec/decisions/ADR-0002-open-closed-typed-nodes.md), [ADR-0007](../../../spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md), [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md), [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md).
**Related FRs:** FR-004 (cross-language prompt construction — established the `@payloadRef → object.value` pattern this FR mirrors).

## Why this doc exists

The metamodel describes stored procedures and table-valued functions via `source.rdb @kind: "storedProc" | "tableFunction"`. The return shape becomes `field.*` children of the entity. **There is no way to declare input parameters** — adopters can model what a procedure returns but not how to call it from application code.

The gap generalizes beyond stored procs: any source kind that takes typed inputs (search request shapes, paginated query parameters, command payloads, future API endpoints) has the same problem.

The original proposal in `/tmp/metaobjects-proposals.md` introduced a new top-level node type `parameter.<subtype>` with the same shape as `field.<subtype>` (same nine subtypes, same `origin.passthrough` child, same name/required attrs). Design review flagged this as overfitting: the metamodel already has a typed-value-shape mechanism (`object.value` + fields), and FR-004 (templates) established the pattern of referencing one from a callable via `@payloadRef`. Stored procs are structurally the same shape — typed input + callable body + output. The same reference pattern applies.

## Layer placement (ADR-0013 litmus test)

`@parameterRef` is a physical / dbProvider attribute. It lives on `source.rdb` and binds the source to a value-object that describes the procedure's input signature. Like `@table`, `@schema`, and `@kind`, it is part of the persistence-binding metadata for the source.

The referenced `object.value` itself is logical (it describes a typed shape that has native bindings in every language); `@parameterRef` is the physical binding from the source to that shape.

## Decision

Add one attribute, `@parameterRef`, to `source.rdb`'s attribute schema in `persistence/source/source-schema.ts`. It carries the name (or FQN) of an `object.value` whose field children describe the procedure's input parameters.

### Wire-format example

```jsonc
// 1. The input shape — an ordinary object.value with typed fields.
//    Fields may carry origin.passthrough to drift-protect against the entities they reference.
{ "object.value": {
    "name": "PhaseSummaryArgs",
    "children": [
      { "field.int": {
          "name": "caseId",
          "@required": true,
          "children": [
            { "origin.passthrough": { "@from": "Case.id" } }
          ]
      }},
      { "field.timestamp": { "name": "asOfDate" } }
    ]
}}

// 2. The proc-backed entity references the input value-object via @parameterRef,
//    exactly as templates reference their payload via @payloadRef.
{ "object.entity": {
    "name": "PhaseSummaryPerCase",
    "children": [
      { "source.rdb": {
          "@kind": "storedProc",
          "@proc": "fn_get_phase_summary_per_case",     // see FR-016 / ADR-0018: kind-aware physical-name attr
          "@schema": "analytics",
          "@parameterRef": "PhaseSummaryArgs"
      } },
      // Return columns are ordinary fields, as today.
      { "field.long":      { "name": "phaseId" } },
      { "field.string":    { "name": "phaseName" } },
      { "field.timestamp": { "name": "enteredAt" } }
    ]
}}
```

Constant in `persistence/source/source-constants.ts`:

```typescript
/** Reference to an object.value describing the input shape of a callable source.
 *  Required for @kind: "storedProc" | "tableFunction"; permitted for any source kind
 *  that has typed inputs (future "search" / "endpoint" / "command" kinds inherit
 *  the same pattern). Wire-format symmetric with template.@payloadRef (FR-004). */
export const SOURCE_ATTR_PARAMETER_REF = "parameterRef";
```

Schema entry on `sourceRdbAttrs`:

```typescript
{
  name: SOURCE_ATTR_PARAMETER_REF,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Name or FQN of an object.value describing the input shape of this source's " +
    "callable interface. Required when @kind is \"storedProc\" or \"tableFunction\"; " +
    "ignored for kinds that have no input parameters (table / view / materializedView). " +
    "Symmetric with template.@payloadRef in FR-004 — the typed-input pattern reuses " +
    "object.value rather than minting a new parameter.* node type.",
}
```

### Semantics

- The value of `@parameterRef` is an `object.value` name. Resolution follows the standard loader rule (bare name resolves within the current root's known objects; FQN form `pkg::name` for cross-package references).
- The referenced `object.value`'s field children **are** the parameter list. Their declaration order is the call-site argument order.
- Each parameter is an ordinary `field.<subtype>` — same vocabulary, same attrs (`@required`, `@default`, `@maxLength`, …), same `origin.passthrough` for drift protection against the entities they came from.
- A single `object.value` may be referenced by multiple sources (multiple procs sharing the same argument shape). Parameter shapes become reusable types in every port.

### Loader validation

| Code | When |
|---|---|
| `ERR_PARAMETER_REF_REQUIRED_FOR_CALLABLE` | `@kind` is `storedProc` or `tableFunction` but `@parameterRef` is missing AND the proc/function takes at least one argument (the proc-takes-no-args case is permitted with `@parameterRef` omitted) |
| `ERR_PARAMETER_REF_UNRESOLVED` | `@parameterRef` names an object that does not exist in the loaded model |
| `ERR_PARAMETER_REF_NOT_VALUE_OBJECT` | `@parameterRef` references an `object.entity` instead of `object.value` (input shapes are value-objects by definition — no identity) |
| `ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND` | `@parameterRef` is set with `@kind: "table"` / `"view"` / `"materializedView"` (these kinds do not accept parameters); kept restrictive to surface authoring mistakes — future kinds that take parameters add themselves to the whitelist |
| `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH` | A parameter field uses `origin.passthrough @from: "Entity.field"` but the parameter's subtype does not match the referenced field's subtype (drift gate) |

### Why this is symmetric with FR-004's `@payloadRef`

FR-004 introduced template metatypes (`template.prompt`, `template.toolCall`) with a `@payloadRef` attribute pointing at an `object.value` that describes the template's typed input variables. The same pattern works for callables:

| FR | Container | Reference attr | Referenced shape |
|---|---|---|---|
| FR-004 | `template.<kind>` | `@payloadRef` | `object.value` (template variables) |
| FR-015 | `source.rdb @kind: "storedProc"` | `@parameterRef` | `object.value` (procedure arguments) |

Whether to UNIFY the two attribute names (e.g., one `@inputRef` covering both) is a future cleanup question. Both attrs target the same conceptual role (typed input shape), but `@payloadRef` is shipped in FR-004 and any rename is breaking. Recommendation: keep both spellings; possibly deprecate one to the other in a later ADR after both have soaked in production.

### Why NOT a new `parameter.<subtype>` node type

The proposals doc originally introduced `parameter.string`, `parameter.int`, `parameter.long`, ... — 9 new subtypes structurally identical to `field.<subtype>`. Reasons that was rejected during design review:

1. **The metamodel already expresses typed shapes** via `object.value` + `field.*`. Adding a parallel `parameter.*` vocabulary duplicates the entire field subtype tree.
2. **The `origin.passthrough` drift-protection mechanism is field-only.** Re-implementing it for `parameter.*` is engine duplication.
3. **FR-004 already established the pattern.** A callable referencing its typed input shape via `@<name>Ref → object.value` is the precedent.
4. **Reusable across more than just stored procs.** Search request shapes, command payloads, future API endpoint bodies are all "typed input shape" patterns. One mechanism covers them all without per-use-case node types.
5. **Strict YAGNI on new node types.** Per CLAUDE.md design discipline, new types are justified only when they express genuinely new semantics. Parameters have the same semantics as fields-on-a-value-object; the role distinction (input vs. state) is contextual to the parent source, not to the value itself.

### Edge case: OUT / INOUT parameters

Some stored procedures (especially in legacy SQL Server / Oracle codebases) have OUT or INOUT parameters that are not part of the return columns and not part of the input shape. They are niche enough that the v1 of this feature does not support them. If a real adopter need surfaces, add `@kind: "in" | "out" | "inout"` as an attribute on the parameter field (a field-level attr, not a parameter-level concern). This is additive and does not affect the v1 design.

## Per-port codegen mapping

| Port | Emission for a `source.rdb @kind: "storedProc" @parameterRef: "PhaseSummaryArgs"` |
|---|---|
| **TypeScript** | Method on the generated repo / service: `getPhaseSummaryPerCase(args: PhaseSummaryArgs): Promise<PhaseSummaryPerCase[]>`. The `PhaseSummaryArgs` type comes from the value-object's TS codegen. Drizzle: `sql.raw` wrapper helper. |
| **Java** | Spring repo method with `@Query(value = "{ call fn_get_phase_summary_per_case(:caseId, :asOfDate) }", nativeQuery = true)` and parameter binding driven by `PhaseSummaryArgs` field order. |
| **Kotlin** | Exposed `transaction { ... }` block with stored-function call wrapper; typed arguments via the `PhaseSummaryArgs` data class. |
| **C#** | EF Core: `context.PhaseSummaryPerCase.FromSqlInterpolated($"SELECT * FROM analytics.fn_get_phase_summary_per_case({args.CaseId}, {args.AsOfDate})")` or a static helper on a `Procedures` partial. |
| **Python** | SQLAlchemy: `session.execute(text("SELECT * FROM analytics.fn_get_phase_summary_per_case(:case_id, :as_of_date)"), args.model_dump())`. Pydantic `PhaseSummaryArgs` validates inputs at call site. |

Every port emits the `object.value` shape (`PhaseSummaryArgs`) as a native type per its existing object.value codegen path. **No new codegen mechanics are required** — both the value-object and the source-with-parameter-ref reuse already-shipped per-port pipelines.

## `migrate-ts` impact

Per [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md), TS owns schema migration:

- **Signature validation against the live DB.** `migrate-ts verify` introspects the function signature via Postgres `pg_proc` (`SELECT * FROM pg_proc WHERE proname = ...`) and validates that the metadata-declared parameter list matches the live function: parameter names match positions, types compatible, optional/required parity, etc.
- **Drift detection.** A parameter added/removed/retyped in the live DB but not in metadata (or vice versa) surfaces as `ERR_DRIFT_PARAMETER_*` during `verify`.
- **No DDL emission of function bodies.** Stored procedure bodies are hand-authored or come from external SQL (`@externalSql`, a future addition). `migrate-ts` does not generate the body; it validates the signature contract between metadata and live DB.

### Migration emit for the signature itself

For a NEW stored procedure declared in metadata for the first time (live DB does not yet have the function): `migrate-ts emit` produces a `CREATE OR REPLACE FUNCTION` skeleton with parameters and return type derived from the metadata, body as a `RAISE NOTICE 'unimplemented'` placeholder. The user fills in the body. This is the same pattern `migrate-ts` already uses for view bodies (where the structure is declarative but the SELECT logic is authored).

## Conformance fixtures

Under `fixtures/conformance/`:

**Positive (6):**

1. `parameter-ref-on-stored-proc/` — full shape: `source.rdb @kind: "storedProc" @parameterRef + object.value with 2 fields + return columns`.
2. `parameter-ref-on-table-function/` — same shape with `@kind: "tableFunction"`.
3. `parameter-ref-with-origin-passthrough/` — at least one parameter field uses `origin.passthrough @from: "Case.id"`; loader's effective-tree resolution links the parameter type to the source field's type.
4. `parameter-ref-shared-across-procs/` — two `source.rdb` instances on different entities both reference the same `object.value`. Confirms reusability.
5. `parameter-ref-optional-parameter/` — one required, one optional parameter (`@required: false` on a field child); call signature reflects optionality per port.
6. `parameter-ref-no-args/` — `@kind: "storedProc"` with `@parameterRef` omitted (a zero-argument procedure). Loader accepts; codegen emits a no-arg method.

**Error (4):**

7. `error-parameter-ref-unresolved/` — `@parameterRef: "NonexistentArgs"`. Expect `ERR_PARAMETER_REF_UNRESOLVED`.
8. `error-parameter-ref-not-value-object/` — `@parameterRef` points at an `object.entity`. Expect `ERR_PARAMETER_REF_NOT_VALUE_OBJECT`.
9. `error-parameter-ref-on-table-kind/` — `@parameterRef` set with `@kind: "table"`. Expect `ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND`.
10. `error-parameter-ref-passthrough-type-mismatch/` — parameter declared `field.int` but `origin.passthrough @from` points at a `field.string`. Expect `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH`.

## Effort estimate

- TS reference (constants + schema + loader validation + `migrate-ts` pg_proc introspect + 10 fixtures): **~3-5 days.**
- Per-port fanout — register the source attr (one line each), wire codegen to emit stored-proc call-site methods using the existing object.value type binding: **~1 day each, parallel.**
- Total elapsed if ports fan out in parallel after TS lands: **~1 week.**

Smaller than FR-014 (TPH) because no per-port inheritance machinery; larger than FR-013 (read-only) because the TS-side `pg_proc` introspect + drift gate is real work.

## Out of scope

- **OUT / INOUT parameter semantics.** Deferred until a real adopter need surfaces. Additive extension via per-field `@kind` attr; does not affect v1.
- **The future `search` / `endpoint` / `command` source kinds.** `@parameterRef` is the established mechanism they will reuse, but each kind is a separate paradigm/kind decision (see ADR-0007 paradigm catalog).
- **Unifying `@parameterRef` and `@payloadRef`** into a single `@inputRef`. FR-004's `@payloadRef` is shipped; renaming is breaking. Both spellings coexist; future ADR may consolidate.
- **`@externalSql` reference for the proc body.** Stored procedure body authoring is a separate concern; this FR is purely about the metadata-declared signature.

## Cross-references

- ADR-0007 — paradigm/kind structure that `source.rdb` belongs to.
- ADR-0013 — physical/logical layering. `@parameterRef` is physical (on the source); the referenced `object.value` is logical.
- ADR-0015 — TS owns schema migration; `pg_proc` introspect lives in `migrate-ts`.
- FR-004 — the template precedent that established `@payloadRef → object.value`.
- The superseded `parameter.<subtype>` proposal in `/tmp/metaobjects-proposals.md` — explained why it duplicates the existing `field.*` vocabulary unnecessarily.
