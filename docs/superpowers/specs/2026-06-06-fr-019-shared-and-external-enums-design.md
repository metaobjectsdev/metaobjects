# FR-019 — Shared + external enum types

**Status:** Design (ready for implementation)
**Created:** 2026-06-06
**Decision:** [ADR-0026](../../../spec/decisions/ADR-0026-shared-and-external-enum-types.md)
**Builds on:** [enum datatype design](2026-05-23-enum-datatype-design.md) (D6 — abstract `field.enum` + `extends`)

## Why this doc exists

`field.enum` members are the cross-port SSOT, but codegen **redeclares them inline
in every consuming entity** (a nested `public enum AuthType` per C# class; a
per-entity union in TS; etc.). The enum design's D6 sanctioned *reuse* via an
abstract `field.enum` + `extends`, yet the emitted code still copies the members
into each consumer. Two adopter needs remain unmet — **shared reuse** (emit one
type) and **external ownership** (reference a hand-written type, don't emit). Per
ADR-0026 we serve both by enhancing the existing abstract-enum vocabulary, not by
adding a new metamodel type.

## Scope

1. **Shared emission:** a **package-level abstract `field.enum`** emits ONE
   standalone enum type per port; concrete `extends`-ing fields reference it.
2. **`@external: true`** on an abstract `field.enum`: suppress emission; consuming
   fields reference an existing type named by the enum, resolved via per-port
   codegen config.
3. Cross-port conformance fixtures pinning both.

Out of scope (unchanged from the enum design): int-backed values, display labels,
native PG enum. **Retired:** the C#-only `@csEnumType` FQN attr (ADR-0026 §3).

## Metamodel (Tier 1 — invariant)

No new type or subtype. Reuses:
- An **abstract `field.enum`** declared at the **package/root level** (a sibling of
  `object.entity`, not nested in one): `abstract: true`, `@values: [...]`. Its
  `name` is the enum's cross-port identity + the emitted type name.
- A concrete `field.enum` on an entity `extends`-ing it (D6).

New attr (own-only, on the abstract `field.enum`):
- **`@external`** — boolean. `true` ⇒ do NOT emit the enum type; consuming fields
  reference an existing type. Default `false`. Loader: `ERR_BAD_ATTR_VALUE` for a
  non-boolean. Validation parity across all five ports (own-only).

Unchanged invariants: `@values` non-empty, member regex, no dupes; the wire form
is the string symbol; the discriminator/`CHECK`/validation contracts are identical
whether the enum is inline, shared, or external. `@external` does NOT change
`@values` semantics — values stay the SSOT (a port that references an external
type still validates against `@values` + emits the `CHECK`).

**No per-port type binding in metadata** (ADR-0001): the namespace/package an
`@external` enum resolves to is a **codegen config** value per port (e.g. an
`enumNamespace` / `enumPackage` setting), never a metadata attr.

## Per-port codegen (Tier 2 — idiomatic)

For a **shared (package-level abstract, non-external) `field.enum` named `E` with
values `[…]`**, emit ONE standalone type, and reference it from consumers:

| Port | Emit the shared type | Field references it |
|---|---|---|
| TS | exported `export type E = "A" \| "B"` (+ `z.enum(["A","B"])` const) at package/module level | property typed `E`; Zod uses the shared `z.enum` |
| C# | namespace-level `public enum E { A, B }` + `modelBuilder…HasConversion<string>()` | property typed `E` (no nested redeclare) |
| Kotlin | `enum class E { A, B }` at package level | property typed `E` |
| Python | `class E(str, Enum): A="A"; B="B"` module-level | field typed `E` |
| DB | one shared `CHECK (col IN ('A','B'))` per consuming column (values are identical) | — |

For **`@external: true`**: emit **nothing** for `E`; each consuming field references
`E` resolved to the port's configured namespace/package + `E` (C#
`<cfg.enumNamespace>.E`, Kotlin/Java `<cfg.enumPackage>.E`, Python an import of
`E` from `<cfg.enumModule>`, TS an import of `E`). A missing config for a
referenced external enum is a **codegen-time error** (clear message naming the
enum + the config key), not a metadata error.

**Byte-identical default:** an enum that is NOT a package-level shared/abstract
enum (the common inline case) emits exactly as today — the per-entity nested
declaration. The shared/external paths are additive branches gated on
"package-level abstract `field.enum`". Drift/golden gates enforce no change to the
inline default.

Each port is open-for-extension (the generators are now subclassable per the
extensibility rounds), so an adopter can further tailor the emitted enum or its
reference without forking.

## Conformance (Tier 5)

Add to `fixtures/conformance/` (metamodel/loader) + the per-port codegen golden
suites:
- **`enum-shared-emitted-once`** — a package-level abstract `field.enum` extended
  by two entities; assert (per port) the enum type is emitted ONCE at
  package/module level and both entities reference it (no nested redeclaration).
- **`enum-external-not-emitted`** — `@external: true`; assert no enum type is
  emitted and consuming fields reference the configured external name; assert the
  `@values` still drive validation + the `CHECK`.
- **`error-external-not-boolean`** — `@external: "yes"` → `ERR_BAD_ATTR_VALUE`
  (all five ports, own-only; byte-identical envelope where provenance allows —
  respect the Java override-field provenance deferral if it applies).
- A codegen-config fixture exercising the per-port `enumNamespace`/`enumPackage`
  resolution for the external case.

The corpus is the oracle: TS reference green first, then each port matches.

## Realization status

- **Unimplemented.** This spec + ADR-0026 lock the decision. Implementation order:
  (1) loader `@external` attr + validation + conformance fixtures (TS green);
  (2) TS shared-emit + external-reference codegen; (3) per-port fan-out
  (C#/Java/Kotlin/Python) against the fixtures; (4) retire `@csEnumType`.

## Cross-references
- [ADR-0026](../../../spec/decisions/ADR-0026-shared-and-external-enum-types.md) — the decision (Option 1 now, Option 2 upgrade path).
- [ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md) — metadata→native type binding is per-port build-time config, not metadata.
- [enum datatype design](2026-05-23-enum-datatype-design.md) — D6 abstract-enum reuse; deferred int-backed/display-label/native-PG-enum.
