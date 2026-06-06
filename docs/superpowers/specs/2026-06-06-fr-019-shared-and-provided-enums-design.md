# FR-019 — Shared + externally-provided enums

**Status:** Design (ready for implementation)
**Created:** 2026-06-06
**Decision:** [ADR-0026](../../../spec/decisions/ADR-0026-shared-and-provided-named-types.md)
**Builds on:** [enum datatype design](2026-05-23-enum-datatype-design.md) (D6 — abstract `field.enum` + `extends`)

## Why this doc exists

`field.enum` members are the cross-port SSOT, but codegen **redeclares them inline
in every consuming entity** (a nested `public enum AuthType` per C# class; a
per-entity union in TS). The enum design's D6 sanctioned *reuse* via an abstract
`field.enum` + `extends`, yet the emitted code still copies the members into each
consumer. Two adopter needs remain unmet — **shared reuse** (materialize one type)
and **external ownership** (reference a hand-written type, don't emit).

Per [ADR-0026](../../../spec/decisions/ADR-0026-shared-and-provided-named-types.md),
the ownership concept is a **`@provided` flag on the named-type declaration**,
applying uniformly to enums and value objects — **not** a field attr and **not**
enum-specific. This FR implements the concept **for enums** (the driving need);
value-object `@provided` is a noted follow-up using the same attribute.

## Scope

1. **Shared materialization:** a **package-level abstract `field.enum`** is
   materialized ONCE per port as a standalone enum type; concrete `extends`-ing
   fields reference it.
2. **`@provided: true`** on the named-type declaration: suppress materialization;
   consuming fields reference an existing type, resolved via per-port codegen
   config.
3. Cross-port conformance fixtures pinning both.

Out of scope (unchanged): int-backed values, display labels, native PG enum.
**Retired:** the C#-only `@csEnumType` FQN attr (ADR-0026 §3).
**Follow-up (not here):** `@provided` on `object.value` (reference a hand-written
value class) — same attribute, separate slice gated on a real need.

## Metamodel (Tier 1 — invariant)

No new type or subtype. Reuses the D6 vocabulary:
- An **abstract `field.enum`** declared at the **package/root level** (a sibling
  of `object.entity`, not nested in one): `abstract: true`, `@values: [...]`. Its
  `name` is the enum's cross-port identity + the materialized type name.
- A concrete `field.enum` on an entity `extends`-ing it (D6).

New attr **on the named-type declaration** (the abstract `field.enum`), own-only:
- **`@provided`** — boolean. `true` ⇒ do NOT materialize the enum type; consuming
  fields reference an existing type. Default `false`. **Not a field attr** — it
  lives on the (abstract) declaration; placing `@provided` on a concrete
  consuming field is invalid. Loader: `ERR_BAD_ATTR_VALUE` for a non-boolean.
  Validation parity across all five ports (own-only).

Unchanged invariants: `@values` non-empty, member regex, no dupes; the wire form
is the string symbol; the discriminator / `CHECK` / validation contracts are
identical whether the enum is inline, shared, or `@provided` (the values stay the
SSOT — a port referencing a provided type still validates against `@values` +
emits the `CHECK`).

**No per-port type binding in metadata** (ADR-0001): the namespace/package a
`@provided` enum resolves to is **codegen config** per port (e.g. an
`enumNamespace` / `enumPackage` / `enumModule` setting), never a metadata attr.

## Per-port codegen (Tier 2 — idiomatic)

For a **shared (package-level abstract, non-provided) `field.enum` named `E` with
values `[…]`**, materialize ONE standalone type and reference it from consumers:

| Port | Materialize the shared type | Field references it |
|---|---|---|
| TS | exported `export type E = "A" \| "B"` (+ a shared `z.enum(["A","B"])`) at module/package level | property typed `E`; Zod uses the shared `z.enum` |
| C# | namespace-level `public enum E { A, B }` + `…HasConversion<string>()` | property typed `E` (no nested redeclare) |
| Kotlin | package-level `enum class E { A, B }` | property typed `E` |
| Python | module-level `class E(str, Enum): A="A"; B="B"` | field typed `E` |
| DB | one shared `CHECK (col IN ('A','B'))` per consuming column (values identical) | — |

For **`@provided: true`**: materialize **nothing** for `E`; each consuming field
references `E` resolved to the port's configured namespace/package + `E` (C#
`<cfg.enumNamespace>.E`, Kotlin/Java `<cfg.enumPackage>.E`, Python an import of
`E` from `<cfg.enumModule>`, TS an import of `E`). A missing config for a
referenced `@provided` enum is a **codegen-time error** (clear message naming the
enum + the config key), not a metadata error.

**Byte-identical default:** an enum that is NOT a package-level shared/abstract
enum (the common inline case) emits exactly as today — the per-entity nested
declaration. Shared and `@provided` are additive branches gated on "package-level
abstract `field.enum`". Drift/golden gates enforce no change to the inline default.

Each port's generators are subclass-extensible (the extensibility rounds), so an
adopter can further tailor the materialized enum or its reference without forking.

## Conformance (Tier 5)

Add to `fixtures/conformance/` (metamodel/loader) + the per-port codegen golden
suites:
- **`enum-shared-materialized-once`** — a package-level abstract `field.enum`
  extended by two entities; assert (per port) the enum type is materialized ONCE
  at package/module level and both entities reference it (no nested redeclaration).
- **`enum-provided-not-materialized`** — `@provided: true`; assert no enum type is
  emitted and consuming fields reference the configured external name; assert the
  `@values` still drive validation + the `CHECK`.
- **`error-provided-not-boolean`** — `@provided: "yes"` → `ERR_BAD_ATTR_VALUE`
  (all five ports, own-only; byte-identical envelope where provenance allows —
  respect the Java override-field provenance deferral if it applies).
- A codegen-config fixture exercising the per-port `enumNamespace`/`enumPackage`
  resolution for the `@provided` case.

The corpus is the oracle: TS reference green first, then each port matches.

## Realization status

- **Unimplemented.** This spec + ADR-0026 lock the decision. Implementation order:
  (1) loader `@provided` attr + validation + conformance fixtures (TS green);
  (2) TS shared-materialize + provided-reference codegen; (3) per-port fan-out
  (C#/Java/Kotlin/Python) against the fixtures; (4) retire `@csEnumType`.

## Cross-references
- [ADR-0026](../../../spec/decisions/ADR-0026-shared-and-provided-named-types.md) — `@provided` as a cross-type provenance flag (enums + value objects); shared vs provided orthogonal; Option 2 upgrade path.
- [ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md) — metadata→native type binding is per-port build-time config, not metadata.
- [enum datatype design](2026-05-23-enum-datatype-design.md) — D6 abstract-enum reuse; deferred int-backed/display-label/native-PG-enum.
