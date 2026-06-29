# ADR-0035: MetaObjects 1.0 — stability commitment, compat policy, and version-line unification

## Status

**Proposed** (2026-06-29). Companion checklist: [`docs/1.0-readiness.md`](../../docs/1.0-readiness.md).

This ADR frames the decisions a 1.0 release commits to; the bracketed **[RATIFY]**
items are open calls for the maintainer to confirm before this moves to *Accepted*.
It does not itself change any code or contract.

## Context

Two recent shifts make 1.0 both *achievable* and *meaningful*, and they are the
turning point:

1. **Scaffold-and-own (ADR-0034).** Generated code is now owned and disposable in
   the consumer's repo; the library ships the engine + reference templates that
   `meta init` copies. This **collapses the public surface** that 1.0 must keep
   stable — the generator internals stop being an API consumers couple to.
2. **The `metaobjects-audit` skill.** The project can now assess how well an app
   has adopted the standard. You can only audit an adoption surface that is stable
   enough to *define* "well-integrated" — the audit is the maturity signal that the
   surface has set.

Against that, the honest tension: the `0.14.0`/`7.6.0` line just shipped **breaking
changes in a minor** (verify strict-by-default; the jsonb open-bag contract). 1.0's
entire value is the *compat promise*, so 1.0 is gated less by "are the features
there" than by "has the breaking-change rate dropped enough to commit to
no-breaking-until-2.0." Three things are still in motion: FR-024 (declared
`api.*`/`operation.*`/`binding.*` — net-new vocabulary), the deprecated
`@metaobjectsdev/codegen-ts/generators` export ("removal in a future major"), and
the fact that "own your codegen" is TS-led (`meta init`) while the JVM/Python/C#
ports own generators via build config.

The version lines also diverge: npm/PyPI/NuGet are on `0.x`; Maven Central is on
`7.x` (a line the Java project inherited, never a public semver commitment).

## Decision

### 1. What 1.0 stabilizes — the compat surface (semver applies; breaking ⇒ 2.0)

**Covered** (a breaking change here requires a MAJOR bump after 1.0):
- **The metamodel vocabulary** — the registered type/subtype/attribute set, enforced
  by `registry-conformance` (`expected-registry.json`). This is *the* durable spine.
- **The canonical authoring + interchange format** — canonical JSON keywords/`@`-attr
  rules (ADR-0006), sigil-free YAML, `extends`/`@via` grammar, package `::` syntax.
- **The wire / normalization contract** — cross-port serialized form (currency minor
  units, pagination, native-return-type contract ADR-0019, jsonb parsed-value).
- **The CLI command surface** — `init` / `gen` / `verify` (per-port: `meta`,
  `dotnet meta`, `mvn metaobjects:*`, `metaobjects`) and their *documented* flags
  (incl. `--lax`/`-Dmeta.lax`, the verify subverbs).
- **The scaffold-and-own contract** — what `meta init` scaffolds and the `Generator`
  interface owned templates implement.

**Not covered** (may change in a minor):
- Generator internals and the reference templates themselves (owned/disposable).
- Runtime-library helper internals (best-effort; idiomatic per port).
- Anything explicitly marked experimental/reserved and not yet in the registry.

### 2. Version-line unification — **[RATIFY]**

**Recommendation: unify all ports to `1.0.0`** at the 1.0 line (npm/PyPI/NuGet
`0.x → 1.0.0`; Maven Central `7.x → 1.0.0`). 1.0 means "v1 of the unified
*standard*"; the Maven `7.x` line was inherited internal versioning, not a public
semver promise, and unifying ends the confusing `0.x`-vs-`7.x` split exactly when we
are declaring one standard. Maven's number *decreases* — defensible as a one-time
reset, and 1.0 is the moment to make that statement.

*Alternative (rejected unless ratified otherwise):* keep independent lines
(npm `→1.0.0`, Maven `→8.0.0`) — perpetuates the split the standard exists to erase.

### 3. Gating items — the breaking-change consolidation window — **[RATIFY each]**

Treat the next one or two `0.x`/`7.x` releases as the window to land every breaking
change we still want, then freeze. Before cutting 1.0:
- **FR-024 declared-API:** land it, **or** explicitly defer post-1.0 with
  `api.*`/`operation.*`/`binding.*` *reserved but unregistered* (so adding them later
  is additive, not breaking). **[RATIFY: land vs defer]**
- **Deprecated `codegen-ts/generators` export:** remove at 1.0 (1.0 is the natural
  major for it), **or** consciously retain one more line. **[RATIFY: remove vs keep]**
- **Cross-port "own your codegen":** ratify that it is *per-port-idiomatic* (TS
  `meta init`; JVM/Python/C# via build config) and **document that explicitly**, OR
  close a parity gap first. **[RATIFY: idiomatic-and-document vs close-gap]**
- **Metamodel freeze:** no pending vocabulary churn; `registry-conformance` is the
  enforcer; the jsonb + verify-strict contracts (just shipped) are the last
  breaking moves on those surfaces.
- **Cross-port conformance complete:** all corpora green; the cross-port
  api-contract jsonb gate fully wired (TS/Python/Java/Kotlin/C#).
- **Migration + policy docs:** a `0.x → 1.0` migration guide and a published
  compatibility policy (this ADR's §1, consumer-facing).

## Consequences

- After 1.0, a breaking change to the metamodel vocabulary, the canonical/wire
  format, the CLI surface, or the scaffold-and-own contract requires a **2.0**. The
  small stable surface (a consequence of scaffold-and-own) makes that a realistic
  commitment, not a straitjacket.
- The deprecation removal and the version-line unification are **one-time 1.0 moves**
  — do them at the boundary, not after.
- The `metaobjects-audit` adoption tiers become a *de facto* readiness signal: a real
  adopter reaching "Deep/Exemplary" with the drift gate wired is evidence the surface
  is stable enough to promise.
- Until ratified, the open **[RATIFY]** items are the agenda for the 1.0 planning,
  tracked in `docs/1.0-readiness.md`.
