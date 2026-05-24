# Design: `field.enum` — first-class enum datatype

**Date:** 2026-05-23
**Status:** Implemented across TS, C#, Java, Python (2026-05-23)
**Author:** Doug Mealing (with Claude)

## Problem

The metamodel has no way to declare that a field's value is drawn from a fixed set of
named symbols (e.g. `Status ∈ {DRAFT, PUBLISHED, ARCHIVED}`). Today the closest a user
can get is `validator.regex` (`^(DRAFT|PUBLISHED|ARCHIVED)$`), which prevents bad data
but produces stringly-typed output: no named type, no autocomplete, no exhaustive
`switch`, no database-level constraint expressing the set.

The missing value is **not data integrity** (regex already closes that) — it is
**codegen output quality**: one declaration should yield an idiomatic, *named* enum type
in every target language plus a database constraint. That value is larger for a
cross-language standard than for a single-language ORM: "declare once → idiomatic
`enum`/union in TS, Java, Python, C# + a portable DB constraint" is the
metamodel-as-spine payoff. A per-language regex is strictly worse output.

## Goals

1. Add `enum` as a **first-class field datatype** (a new field subtype, peer to
   `string`, `currency`, etc.), so every language port recognises it as a distinct type.
2. Let the member set be declared with a single typed attribute (`@values`).
3. Support reuse across fields/entities via the **existing abstract-field + `extends`**
   mechanism — no new reuse syntax.
4. Emit idiomatic named types per language and a **portable** DB constraint.
5. Preserve the cross-language wire format and vocabulary (TS / Java / Python / C#).
6. Keep authoring AI-first: one obvious form, no silent YAML type-coercion (see
   forthcoming ADR-0006).

## Non-goals (out of scope)

- **Integer-backed enums** (where a member's symbol name differs from a stored number).
  This needs per-member symbol→value assignment and is materially more complex; deferred
  to a later design. v1 members are symbols stored as their own string.
- **Display labels.** Human-facing labels for members (e.g. `DRAFT` → "Draft") belong to
  the presentation/view layer, not the enum datatype. The enum stays a pure domain concept.
- **Native Postgres `CREATE TYPE ... AS ENUM`.** Breaks PG/SQLite parity and is a
  migration footgun (`ALTER TYPE ADD VALUE` is non-transactional; values can't be dropped
  or reordered). May return later as an opt-in `@dbEnum`-style flag if a consumer needs it.
- **A standalone `enum.*` named-type metatype + `@enumRef`.** Rejected in favour of the
  field subtype (see Decision D2).

## Decisions

- **D1 — `enum` is its own datatype, not "string-backed" in the metamodel.** Add
  `FIELD_SUBTYPE_ENUM = "enum"` to `FIELD_SUBTYPES`. The metamodel has **no "backing"
  concept** — the subtype *is* the datatype. This mirrors `currency`, which sits in the
  same flat subtype list as a peer of `long` (not as "a long with a flag") and whose
  integer storage / numeric wire form lives entirely in **codegen** mappings. `enum`'s
  string storage and string wire form are likewise codegen concerns, not metadata.

- **D2 — Field subtype, not a validator and not a standalone type.**
  - *Not a validator* (`validator.enum`): a validator is an optional, additive runtime
    constraint; promoting one to a nominal type conflates "constraint" with "type" (a layer
    violation). Validators map to runtime checks / annotations / Zod refinements, never to a
    field's declared type.
  - *Not a standalone `enum.*` metatype + `@enumRef`*: that introduces a second
    reusable-type concept when abstract-fields already are MetaObjects' reusable-typed-property
    mechanism, plus a new reference/resolver path. Heavier and less consistent.
  - A field subtype determines the generated type directly — the cleanest model, and
    consistent with how `field.object` + `@objectRef` already let field-level metadata
    determine a field's generated type.

- **D3 — Members declared via `@values`.** A required string array on the `field.enum`.
  Declaration order is significant (it is the canonical member order for every port).

- **D4 — v1 is string-backed; int-backed deferred.** Each member's symbol *is* its stored
  and transmitted string value. No `@backing` knob. Int-backed enums are a future codegen
  mapping of the *same* subtype, not a new datatype — the model already accommodates them.

- **D5 — DB representation: `varchar` + `CHECK`.** Portable across Postgres and SQLite;
  adding/removing a member is a cheap CHECK swap. Native PG enum is explicitly out (see
  Non-goals).

- **D6 — Reuse via abstract field + `extends`.** No new syntax. An abstract `field.enum`
  carries `@values`; concrete fields `extends` it and inherit the members through the
  existing effective-children resolution. This ships the **first conformance fixture that
  exercises field-to-field `extends`**, which is currently supported but untested — the
  feature de-risks that path as a side effect.

- **D7 — AI-first authoring guard.** Because the subtype is string-typed, every `@values`
  element must parse as a string. A non-string element (e.g. YAML coercing `TRUE` → boolean
  or `404` → number under the 1.2 core schema) is **rejected at load time** with a
  "quote this value" error. The subtype is the type-expectation that makes the guard
  deterministic. (General rule captured in ADR-0006.)
  - **Implementation note (as-built):** at the *metadata (canonical JSON)* layer this guard
    is moot — `@values` is a `stringarray` whose loader coercion stringifies every element,
    so a non-string member cannot reach validation as a non-string (it becomes its string
    form and is then caught by the identifier-pattern check). The non-string-rejection
    fixture was therefore dropped (see Conformance fixtures). The live value of D7 is the
    *YAML authoring* coercion guard, deferred to ADR-0006; the shipped loader-level
    enforcement is the identifier-pattern + non-empty + no-duplicate rules below.

## Key prior-art findings

- **Field subtype = datatype.** `FIELD_SUBTYPES` is a single flat list of 15 subtypes
  (`server/typescript/packages/metadata/src/core/field/field-constants.ts:25`). `currency`
  is a peer entry (line 23), not a decorated `long`. Its storage/wire mapping lives in the
  codegen column-mapper. `enum` follows the identical pattern.
- **Abstract fields + field-`extends` already work** (mechanically): any node may declare
  `abstract: true` and `extends: "<ref>"`; effective-children resolution carries inherited
  children, and `MetaField` resolves its super. No fixture exercises *field-to-field*
  extends yet — this design adds the first.
- **`@objectRef` precedent:** `field.object` + `@objectRef` already lets a field-level
  attribute determine the field's generated nominal type — establishing that
  type-determining field metadata is idiomatic, which is why `enum` belongs at the field
  layer, not the validator layer.
- **No prior enum art:** no existing spec, roadmap item, or ADR proposes a data-level enum.
  ADR-0003 deliberately kept `@cardinality` an *open* string at the metamodel level — a
  signal to keep any closed-vocabulary feature opt-in and lightweight, which `field.enum`
  is (members are user-defined, not a fixed metamodel set).

## Metamodel addition

A new field subtype and one attribute.

```
FIELD_SUBTYPE_ENUM = "enum"        // added to FIELD_SUBTYPES
FIELD_ATTR_VALUES  = "values"      // @values: string[] (required on field.enum)
```

Schema (`field-schema.ts`): `@values` is a required string array, valid only on the
`enum` subtype; load-time validation enforces (a) presence, (b) every element is a
non-empty string, (c) no duplicate members, and (d) every member matches a conservative
identifier pattern (`^[A-Za-z_][A-Za-z0-9_]*$`) so it is a legal enum member name in
*every* target language (C#/Java identifiers, TS union members) **and** a stable stored
string — i.e. symbol == stored value, with no name↔value divergence. Declaration order is
preserved verbatim. Members that are not identifier-safe (kebab-case, leading digit, etc.)
require a symbol↔stored-value mapping and are deferred together with int-backing.

### Authoring

```yaml
# one-off
field.enum:
  name: status
  values: ["DRAFT", "PUBLISHED", "ARCHIVED"]   # quoted; validated as strings

# reusable — abstract + extends
field.enum: { name: Status, abstract: true, values: ["DRAFT", "PUBLISHED", "ARCHIVED"] }
field.enum: { name: status, extends: Status }
```

Canonical JSON form is the equivalent one-key-node encoding (`{ "field.enum": { "name":
"status", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } }`).

> **YAML attribute spelling.** The examples show the unsigiled `values:` key. Under the
> *current* YAML format an attribute is `"@values":` (quoted `@`-prefixed). Whether YAML
> authoring drops the `@` sigil (treating any non-structural key as an attribute) is being
> decided in ADR-0006; this spec defers that spelling to the ADR and treats `@values` /
> `values` as the same attribute. The canonical JSON spelling (`@values`) is fixed.

## Codegen mappings

Each port dispatches on the `enum` subtype; the string storage/wire form is a mapping, not
metadata.

| Concern | Output |
|---|---|
| TS type | `export type Status = "DRAFT" \| "PUBLISHED" \| "ARCHIVED";` |
| TS validation | `z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"])` |
| C# type | `public enum Status { DRAFT, PUBLISHED, ARCHIVED }` |
| C# persistence | EF Core `HasConversion<string>()` — stored as the member string |
| DB DDL | `varchar` column + `CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))` |
| Wire (all langs) | the member string, always |

**Type-name derivation:**
- Reusable (extends an abstract `field.enum`): the abstract field's name (`Status`),
  emitted once and shared by every field that extends it.
- Inline (members declared directly on a concrete field, no extends): `<Entity><FieldPascal>`
  (e.g. a `status` field on `Order` → `OrderStatus`), so it remains a named, referenceable
  type rather than an anonymous union.

**Java / Python:** the metamodel vocabulary (`enum` subtype + `@values`) is the
cross-language contract and is defined now. Codegen emission (`enum` in Java, `enum.Enum`
in Python) lands when those ports reach the relevant codegen tier; the contract does not
wait on them. Locking the vocabulary now — while C# is still catching up — is cheaper than
retrofitting it across four ports later.

## Array-of-enum

`field.enum` with `isArray: true` (`field.enum[]` in YAML sugar) is a list whose every
element is constrained to the member set. Codegen: `Status[]` / `z.array(z.enum([...]))`;
DB representation follows the existing array storage strategy for the dialect. Element
membership is validated the same way as the scalar case.

## Cross-language contract (must be identical across ports)

- Subtype name: `enum`.
- Member-set attribute: `@values` (string array, declaration order significant).
- Wire format: the member string, on every endpoint and every language.
- Members are case-sensitive and compared exactly.

## Conformance fixtures

1. **`enum-inline`** — a concrete `field.enum` with `@values`; expected output round-trips
   the subtype + members.
2. **`enum-abstract-extends`** — an abstract `field.enum` extended by a concrete field; the
   **first fixture exercising field-to-field `extends`**, asserting members are inherited.
3. **`enum-array`** — `field.enum[]`; element-membership semantics.
4. **`error-enum-missing-values`** (negative) — `@values` absent → `ERR_MISSING_REQUIRED_ATTR`.
5. **`error-enum-empty-values`** (negative) — `@values: []` (present but empty) → `ERR_BAD_ATTR_VALUE`.
6. **`error-enum-duplicate-member`** (negative) — duplicate members → `ERR_BAD_ATTR_VALUE`.
7. **`error-enum-non-identifier-member`** (negative) — a member like `"in-progress"`
   (non-identifier-safe) → `ERR_BAD_ATTR_VALUE`, pointing the author at the deferred
   symbol↔value path.

(As-built: the `enum-reject-nonstring-value` fixture from the original design was dropped —
see D7's implementation note: stringarray coercion makes a non-string member unreachable at
the metadata layer. The empty-`@values` fixture, surfaced during review, replaced it.)

## Testing

- Metadata package: load/validate unit tests for the schema rules (D3, D7), abstract +
  extends inheritance, and the negative cases.
- codegen-ts: TS union + `z.enum` emission, inline vs reusable type-name derivation,
  array-of-enum.
- C#: real `enum` + `HasConversion<string>()`, DDL `CHECK` emission.
- Conformance: the fixtures above run across every implemented port.

## Deferred (named so they are not silently dropped)

- Integer-backed enums (per-member symbol→value).
- Non-identifier-safe member strings (kebab-case, leading digit, etc.) needing a
  symbol↔stored-value mapping.
- Display labels (presentation/view layer).
- Native Postgres `CREATE TYPE ... AS ENUM` (opt-in `@dbEnum`-style flag).
- **C# scalar-array codegen** (incl. array-of-enum): the C# EF Core tier has no scalar-array
  emission yet, so an `isArray` enum is currently emitted as a scalar. When scalar-array
  codegen lands, suppress the column-level `CHECK` for array-of-enum (TS already guards
  `!isArray`). Tracked here so it isn't lost. The `enum-array` fixture exercises only the
  loader/serializer round-trip today (which all ports handle).
