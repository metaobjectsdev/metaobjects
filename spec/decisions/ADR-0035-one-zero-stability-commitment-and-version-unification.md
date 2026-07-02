# ADR-0035: MetaObjects 1.0 — stability commitment, compat policy, and version-line unification

## Status

**Proposed** (2026-06-29; §2 version-line strategy **ratified 2026-07-02** — decouple).
Companion checklist: [`docs/1.0-readiness.md`](../../docs/1.0-readiness.md).

This ADR frames the decisions a 1.0 release commits to; the bracketed **[RATIFY]**
items are open calls for the maintainer to confirm before this moves to *Accepted*.
It does not itself change any code or contract. **§2 (version-line strategy) is
ratified: decouple — npm/PyPI/NuGet `→1.0.0`, Java/Kotlin `→8.0.0`, tied by a shared
`Metamodel 1.0` spec version.** The §3 items (A2 FR-024, A3 deprecated export, A4
own-your-codegen) remain open.

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

Against that, the honest tension: the last two lines each shipped **breaking changes
in a minor** — `0.14.0`/`7.6.0` (verify strict-by-default; the jsonb open-bag
contract) and then `0.15.0`/`7.7.0` (the metamodel-1.0 vocabulary program:
instant-default timestamps + the `@dbColumnType` slim). That second round was the
*intended* pre-1.0 vocabulary finalization (ADR-0036/0037/0038) — a decision framework
now governs future additions, so the churn should stop here — but it does mean the
breaking-change rate has not yet demonstrably dropped. 1.0's entire value is the
*compat promise*, so 1.0 is gated less by "are the features there" than by "has the
breaking-change rate dropped enough to commit to no-breaking-until-2.0" — which now
wants at least one no-breaking release *after* `0.15.0`/`7.7.0`. Three things are still in motion: FR-024 (declared
`api.*`/`operation.*`/`binding.*` — net-new vocabulary), the deprecated
`@metaobjectsdev/codegen-ts/generators` export ("removal in a future major"), and
the fact that "own your codegen" is TS-led (`meta init`) while the JVM/Python/C#
ports own generators via build config.

The version lines also diverge: npm/PyPI/NuGet are on `0.x`; Maven Central is on
`7.x` (a line the Java project inherited, never a public semver commitment). This
divergence turns out to be **unbridgeable by unification** — Maven cannot go
backwards to `1.0` (§2) — which is what drove the decoupled, spec-versioned strategy.

Since this ADR was drafted, one more breaking round shipped: **`0.15.1`/`7.7.1` —
the `index.*` type + `identity.secondary` key-purity (ADR-0040, `@unique` removed)**.
That is now the last breaking move, and it reset the quiet-period clock.

## Decision

### 1. What 1.0 stabilizes — the compat surface (semver applies; breaking ⇒ 2.0)

The **covered set below is what `Metamodel 1.0` names** (§2): the shared spec version
*is* this compat surface. A breaking change to any covered item bumps the spec
version's major (Metamodel 2.0) and forces a major on every affected package;
per-port packages may move for their own reasons without touching the spec version.

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

### 2. Version-line strategy — **[RATIFIED 2026-07-02: decouple]**

The prior draft recommended unifying all ports to `1.0.0`. **That is rejected: it
is not achievable for the JVM ports.** `1.0.0 < 7.7.1` under both semver precedence
(compared numerically, left to right) and Maven's `ComparableVersion`, and
npm/Maven Central/PyPI/NuGet all *forbid* republishing a lower coordinate over a
higher one. Rolling Maven `7.7 → 1.0` would make the stable release rank **older**
than what JVM adopters already have — every ranged dependency (`[7.0,8.0)`) and
"latest" resolution would silently refuse the upgrade. A package cannot go
backwards; the registries enforce it.

**Decision — decouple the shared *spec* version from the per-ecosystem *package*
versions.** This is the OpenTelemetry / Protobuf-editions model, and it is the
natural fit for a project whose thesis is already "the metamodel is the durable
spine, generated code is disposable":

- **A shared `Metamodel 1.0` spec version** is the coordinating artifact and the
  bearer of the stability promise (see §1). Every port advertises *"implements
  Metamodel 1.0"*, asserted by the conformance corpora that already run
  byte-for-byte across all five ports (our executable analog to OTel's
  spec-compliance matrix). The spec version bumps **only** when the shared
  vocabulary or wire/canonical contract changes — not for per-port work.
- **Package versions stay ecosystem-natural and only move forward:**
  - **npm / PyPI / NuGet:** `0.15.x → 1.0.0` — a legitimate forward move that fires
    the semver 1.0 promise.
  - **Java / Kotlin (Maven Central):** `7.7.x → 8.0.0` — a forward major. This is the
    **Angular 2→4 precedent**: jump a mature sibling *up* to a clean major rather
    than force a false, resolver-breaking alignment. `8.0` reads honestly as "the
    stable major after the 7.x line."
- **"The stable release" = Metamodel 1.0**, delivered simultaneously as
  npm/PyPI/NuGet `1.0.0` + Maven/Kotlin `8.0.0`.

The two lines never collide: npm climbs `1.x → 2.x…` and Maven climbs `8.x → 9.x…`
on separate registries with no shared coordinate. The only shared number is the
spec version, which is not a package coordinate.

*Alternatives rejected:* **unify-all-up-to-`8.0`** (forces the young ports to `8.0`,
implying seven prior stable majors that never existed, and still needs permanent
Arrow-style lockstep to deliver "same number = same features"); **unify-to-`1.0`**
(resolver-illegal for Java, above); **keep-independent-with-no-spec-version** (viable
— the AWS/Sentry default — but squanders the project's core asset: a single
conformance-gated metamodel that *is* the coordinating artifact).

**Implementation dependency:** decouple requires a machine-readable
`metamodelVersion` marker — a field in the spec/registry every port emits, asserted
by the conformance matrix. Pre-cut the vocabulary is "Metamodel 0.x / in
development"; the cut *freezes* it as `1.0` (mirroring OTel's own 0.x→1.0). Tracked
in `docs/1.0-readiness.md` (§C).

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
- **Metamodel freeze:** the metamodel-1.0 vocabulary program (`0.15.0`/`7.7.0`;
  ADR-0036/0037/0038) was the intended finalization, and ADR-0037 sets the framework
  for future additions; `registry-conformance` is the enforcer. **The actual last
  breaking move was `0.15.1`/`7.7.1` — the `index.*` type + `identity.secondary`
  key-purity (ADR-0040, `@unique` removed).** That resets the quiet-period clock
  (§G3): the first *no-metamodel-breaking* coordinated release must come *after*
  `0.15.1`/`7.7.1` (only A2/FR-024 could add another breaking round — hence it must
  land additively or defer).
- **Cadence discipline (going forward).** The fast Maven minor cadence (`7.3→7.7` in
  ~17 days) was breaking-change *velocity*, not mislabeling — but the decouple scheme
  (§2) fixes the underlying churn: most releases stop being metamodel events. Apply
  the semver rule strictly — the trigger is *new public surface, not code size*: a
  **package MINOR** adds surface a consumer can newly depend on (codegen output, a CLI
  flag, a newly-supported vocab member); a **package PATCH** is a bugfix/refactor with
  no new surface (e.g. the `0.15.2` output-prompt fix — one-port, no surface); the
  **Metamodel spec version** bumps only when the shared vocabulary/wire contract
  itself changes. A run of minors for non-additive changes is the "minor churn"
  anti-pattern.
- **Cross-port conformance complete:** all corpora green; the cross-port
  api-contract jsonb gate fully wired (TS/Python/Java/Kotlin/C#).
- **Migration + policy docs:** a `0.x → 1.0` migration guide and a published
  compatibility policy (this ADR's §1, consumer-facing).

## Consequences

- After 1.0, a breaking change to the metamodel vocabulary, the canonical/wire
  format, the CLI surface, or the scaffold-and-own contract requires a **2.0**. The
  small stable surface (a consequence of scaffold-and-own) makes that a realistic
  commitment, not a straitjacket.
- The deprecation removal and the version-line re-baselining (npm/PyPI/NuGet `→1.0.0`,
  Java/Kotlin `→8.0.0`) are **one-time 1.0 moves** — do them at the boundary, not after.
- A new durable artifact is introduced: the **`Metamodel N.M` spec version** and its
  `metamodelVersion` marker. Post-1.0 the spec version — not any single package
  number — is what communicates cross-language parity and carries the compat promise.
- The `metaobjects-audit` adoption tiers become a *de facto* readiness signal: a real
  adopter reaching "Deep/Exemplary" with the drift gate wired is evidence the surface
  is stable enough to promise.
- Until ratified, the open **[RATIFY]** items are the agenda for the 1.0 planning,
  tracked in `docs/1.0-readiness.md`.
