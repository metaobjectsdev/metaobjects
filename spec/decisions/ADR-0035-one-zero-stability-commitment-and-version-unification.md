# ADR-0035: MetaObjects 1.0 — stability commitment, compat policy, and version-line unification

## Status

**Accepted** (2026-06-29; all **[RATIFY]** items resolved 2026-07-02).
Companion checklist: [`docs/1.0-readiness.md`](../../docs/1.0-readiness.md).

This ADR frames the decisions a 1.0 release commits to. All bracketed **[RATIFY]**
items are now resolved:
- **§2 version-line strategy — decouple:** npm/PyPI/NuGet `→1.0.0`, Java/Kotlin
  `→8.0.0`, tied by a shared `Metamodel 1.0` spec version.
- **§3 A2 FR-024 — defer** (reserved-but-unregistered post-1.0).
- **§3 A3 deprecated export — remove at the 1.0/8.0 cut** (G2, not before).
- **§3 A4 own-your-codegen — ratified per-port-idiomatic + documented.**

It does not itself change code; the one-time moves it commits to (version
re-baselining, the export removal) execute at the cut per `docs/1.0-readiness.md` §G.

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

### 3. Gating items — the breaking-change consolidation window — **[RATIFIED 2026-07-02]**

Treat the next one or two releases as the window to land every breaking change we
still want, then freeze. Before cutting 1.0:
- **FR-024 declared-API — [RATIFIED: DEFER].** `api.*`/`operation.*`/`binding.*` stay
  **reserved but unregistered** post-1.0 (they are already absent from
  `expected-registry.json`; ADR-0030 defines the shape). Adding them later is
  *additive*, so deferral costs nothing and keeps the declared-API surface out of the
  1.0 breaking window. This is what makes the quiet period achievable — it removes the
  only remaining candidate for another breaking round (§C3). Tracked in #10.
- **Deprecated `codegen-ts/generators` export — [RATIFIED: REMOVE at the cut].** The
  `@deprecated ADR-0034` re-exports (`entityFile`/`queriesFile`/`routesFile`/`barrel`
  from `@metaobjectsdev/codegen-ts/generators`) are removed **as part of the 1.0/8.0
  major bump (G2)** — *not before*. Removing an export is itself a breaking change;
  doing it at the major absorbs it, whereas doing it during the run-up would restart
  the quiet-period clock (§G3). Consumers migrate to the `meta init`-scaffolded owned
  copies under `codegen/generators/*`.
- **Cross-port "own your codegen" — [RATIFIED: idiomatic + document].** The per-port
  split is intentional and *not* a parity gap to close: TS uses `meta init`
  scaffold-and-own; the JVM/Python/C# ports own their codegen via build config
  (Maven `metaobjects:gen`, `metaobjects gen`, `dotnet meta gen`). Documented in
  `docs/features/own-your-codegen.md` (readiness D4).
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
  flag, a newly-supported vocab member — **but see Amendment 1: "vocab member" is too
  coarse, and taking it literally re-created exactly the minor churn this bullet was
  written to stop**); a **package PATCH** is a bugfix/refactor with
  no new surface (e.g. the `0.15.2` output-prompt fix — one-port, no surface); the
  **Metamodel spec version** bumps only when the shared vocabulary/wire contract
  itself changes. A run of minors for non-additive changes is the "minor churn"
  anti-pattern.
- **Cross-port conformance complete:** all corpora green; the cross-port
  api-contract jsonb gate fully wired (TS/Python/Java/Kotlin/C#).
- **Migration + policy docs:** a `0.x → 1.0` migration guide and a published
  compatibility policy (this ADR's §1, consumer-facing).

## Amendment 1 (2026-08-17) — "a newly-supported vocab member" splits three ways

The cadence-discipline bullet above lists "a newly-supported vocab member" among the
triggers for a package MINOR. Applied literally it became a rule that **any** registry
addition is a MINOR — and that rule produced the churn this ADR exists to prevent:
`0.22.0` and `0.23.0` were both cut MINOR for additions a project declaring no
`requirement.*` nodes could not observe at all, each changelog saying so in its own
opening paragraph. Four registries move per cut here, so a wasted minor is not free.

The error is treating `expected-registry.json` as consumer surface. It is an **internal**
gate: five ports byte-matching one manifest is how we stop the ports drifting from each
other. Its churn is evidence about *us*, not about an adopter's project. "New public
surface, not code size" was the right instinct; "vocab member" was the wrong unit.
Vocabulary sorts by what it can do to a consumer:

- **A new ATTRIBUTE ⇒ PATCH.** Reachable only by authoring it; every existing document
  loads unchanged and emits byte-identical output. Nothing to adopt deliberately.
- **A new top-level TYPE ⇒ MINOR.** A new modeling concept with its own children,
  validation, and usually tooling surface (`requirement.*` brought a `verify` pass and
  summary output). Genuinely new surface to depend on.
- **A new SUBTYPE ⇒ either, and the test is whether it is INERT.** PATCH when only
  authoring it can reach it: no existing valid document changes meaning or output,
  nothing previously permitted is narrowed, nothing reserved is consumed. MINOR when
  any of those fails — closing a wildcard, promoting a reserved-not-registered member
  (ADR-0007 Amendment 2 / ADR-0040), or shifting what the recommended shape for an
  existing field is — or when it headlines a release and you want the range bump on
  purpose.

The caret rule is not to be inverted. "Pre-1.0 `^0.22.x` resolves `<0.23.0`, so a
consumer adopts a MINOR deliberately" is a reason to **choose** MINOR when that gate is
wanted; it is not a reason additive vocabulary must be MINOR. A minor spent on a change
nobody can observe is a gate you no longer have when something real needs it.

This amendment changes cadence policy only. It does not touch §1's post-1.0 compat
promise: after 1.0, a **breaking** change to the metamodel vocabulary still requires a
MAJOR, whether the break is an attribute, a subtype, or a type — **but see Amendment 2
for WHICH major: the metamodel's own, not the package's.** Operational form of the
rule (with worked rows): `docs/RELEASING.md` → "Versioning policy".

## Amendment 2 (2026-08-20) — two contracts, two numbers

**Severs §1's clause "and forces a major on every affected package."** A breaking change
to the METAMODEL moves `metamodelVersion` and does **not**, by itself, move a package
major. Design: [`docs/superpowers/specs/2026-08-20-two-contracts-versioning-design.md`](../../docs/superpowers/specs/2026-08-20-two-contracts-versioning-design.md).

§1 bound two unrelated promises to one number: the SOFTWARE surface (exports, CLI flags,
generated-code shape) and the METADATA contract (registered vocabulary, canonical format,
wire contract). Under that binding, one vocabulary retirement drags npm to `2.0.0` and
Maven to `9.0.0`, and the package majors become a running count of metamodel edits. The
measured cadence — **19 minor lines in 87 days** across 90 tags — is what makes the
consequence concrete rather than theoretical, and the ADR-0052 roadmap correction
(2026-08-19) is where it first bit: a post-1.0 `1.1` could not carry FR-037's or FR-038's
vocabulary retirements *because of this clause*.

After this amendment:

- **Package version** (npm/PyPI/NuGet `1.x`, Maven `8.x`) promises the software surface.
  Full SemVer; a break is `2.0.0` / `9.0.0`.
- **`metamodelVersion`** (`"0.9"` today, `"1.0"` at the cut; the first key of the
  byte-gated `expected-registry.json`, shipped in all five ports since #145) promises the
  metadata contract. A break moves ITS major.
- §1's covered set is unchanged in *content*. What changes is which number carries it:
  the metamodel vocabulary, the canonical/interchange format and the wire contract are now
  borne by `metamodelVersion`; the CLI surface and the scaffold-and-own contract stay on
  the package version, where they belong.
- **A package MINOR is "never breaking ON THE SOFTWARE SURFACE."** A release that breaks
  the metadata contract also moves `metamodelVersion` and says so in the changelog.

**The cost, stated so it is not discovered later.** Post-1.0 the caret rule stops being a
gate — `^1.0.0` accepts `1.1.0` — so the package MAJOR is the only coordinate a resolver
refuses to cross. Severing this link removes the only *mechanical* protection against
auto-adopting a metadata break. What replaces it today is that the adopter set is
**enumerable and reachable** (six projects). That is a true statement about 2026 and a
coherent basis for the trade; it is written here because it is a premise that expires.

**Deferred, with triggers.** A declared metadata target plus a loader/`verify`
compatibility check — the mechanical replacement — is deferred until the adopter set stops
being reachable. It is more expensive than it looks: `metamodelVersion` is a property of
the LIBRARY, and there is nowhere an adopter declares *"my metadata targets Metamodel
1.0"*; adding that is new vocabulary in five ports plus a compatibility matrix.
Per-item `experimental`/`stable` markers (Kubernetes) and editions (Rust) are likewise
deferred with written triggers in the design doc.

**Cadence is a separate lever and is free.** Nothing forces one release per merged change;
batching removes most of the number pressure without any policy change at all.

## Consequences

- After 1.0, a breaking change to the CLI surface or the scaffold-and-own contract
  requires a package **2.0** / **9.0**; a breaking change to the metamodel vocabulary,
  the canonical/wire format or the interchange format moves **`metamodelVersion`'s**
  major instead (**Amendment 2**). The
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
