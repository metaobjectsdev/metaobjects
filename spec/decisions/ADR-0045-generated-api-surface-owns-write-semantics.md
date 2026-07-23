# ADR-0045: The generated API surface owns metamodel write semantics

## Status

**Accepted** (2026-07-23). Fixes the Kotlin + Python legs of `field.timestamp @autoSet` (issue #203 follow-up, #229): the shipped Kotlin generated Spring controller and Python generated FastAPI router did not stamp `@autoSet` timestamps, so an adopter deploying those artifacts silently lost a semantic the changelog says shipped in all five ports. Generalizes the FR-036 decision ("constraint validation must be enforced at the wire tier, not left decorative") from validation to *all* metamodel-guaranteed write semantics.

## Context

`field.timestamp @autoSet: onCreate|onUpdate` declares "**the generated CRUD stamps `now()` — the caller does not.**" #203 shipped this across all five ports, but a scoping pass for the cross-port parity gate (#229) found the stamping is implemented in a **different architectural layer per port**, and two ports' outermost generated write artifact does not honor it:

| Port | `@autoSet` stamped in | Generated **API-surface** artifact guarantees it? |
|---|---|---|
| TS | codegen Zod validators, called by the emitted routes | ✅ |
| C# | generated routes (`RoutesGenerator`) | ✅ |
| Java | generated controller/DTO (`stampForInsert` / `stampAutoSetOnUpdate`), *then* delegates to the consumer repository seam | ✅ |
| Python | `ObjectManager` runtime only — the generated router delegates raw DTOs to a consumer repository seam | ❌ guarantee lives *below* the seam, in a MetaObjects runtime package the adopter may not wire |
| Kotlin | generated Exposed **repository** only — the generated controller does its own inline `transaction { Table.insert{} }` writes, never uses the repository, has zero `@autoSet` awareness | ❌ shipped controller does not stamp |

The generated **API surface** (the REST controller/routes an adopter deploys) is the outermost write artifact. When the `@autoSet` guarantee lives *below* a consumer-supplied seam (Python's repository `Protocol`; Kotlin's ignored repository), a metamodel-guaranteed semantic silently becomes a property of **hand-written consumer code** — a direct violation of "pattern-derivable from metadata = codegen, never hand-code." It also breaks the substrate promise: Python's only shipped stamping is in `ObjectManager` (a MetaObjects runtime package), so an adopter who wires their own persistence into the generated router gets a deployed API that quietly drops a shipped FR. "Generated code runs without MetaObjects" must include running *with the declared semantics* without MetaObjects.

The gap survived because **no `@autoSet` scenario existed in `api-contract-conformance` or `persistence-conformance`** — the wire tier was never gated for it. This is the same class of hole FR-036 closed for constraint validation (decorative in C#/Python until the wire tier was made to enforce it).

## Decision

**The outermost generated write-path artifact an adopter deploys must itself guarantee every metamodel-declared write semantic. No consumer-supplied seam may sit between the guarantee and the wire.**

1. **API surface stamps.** A generated REST controller / route handler stamps `@autoSet` (and enforces the analogous FR-036 constraint checks) in the generated code, before any consumer-supplied persistence seam. Java is the canonical shape: stamp in the controller/DTO, *then* delegate to the repository — layering and semantic-ownership are orthogonal.
2. **Persistence-layer stamping stays** as the carrier for non-HTTP writes (the runtime pillar) and as defense-in-depth. Kotlin's generated repository, Python's `ObjectManager`, and any ORM-tier stamping are retained. Double-stamping is idempotent-harmless (two `now()` reads, same semantics). The rule is **not** "only the API layer stamps"; it is "the generated API artifact never *depends* on an unspecified layer beneath it for a metamodel-guaranteed write semantic."
3. **Conformance gates the wire tier.** The `@autoSet` write contract is gated in `api-contract-conformance` on every port's generated *and* reference lane, with **behavioral** assertions (a fresh insert's `createdAt == updatedAt`; a later update leaves `createdAt` and bumps `updatedAt`; caller-supplied `@autoSet` values are ignored) — field-vs-field comparisons, not exact-match, since `now()` is nondeterministic. The absence of such an assertion vocabulary is what let a non-stamping controller ship green.
4. **Not breaking, no new vocabulary.** `@autoSet` is an existing registered attr; this changes only *where* the guarantee is enforced in generated output. Output for entities with no `@autoSet` field is byte-identical (pinned by no-churn tests).

### Why not the alternatives

- **Rewire the Kotlin controller to delegate to the generated repository** (so the repository's stamping applies): rejected as the vehicle for this fix. The generated controller already handles TPH, #214 write-through read-views, M:N traversal, and FR-009 filters; the generated repository is FR-035 Phase-2 work with explicit gaps (no TPH polymorphic surface, no read-only view repository). Routing the controller through it is a feature-parity project that would churn all generated output and block a semantics bug on Phase-2 completion. It may be reconsidered later on its own merits; it is not this decision.
- **Leave stamping persistence-only + document it**: rejected — the shipped artifact violates a contract the changelog states shipped in all five ports. That is a bug, not a documentable choice.
- **Move *all* ports to persistence-only stamping** (make Python/Kotlin the model): rejected — it inverts the substrate promise (the deployable artifact would depend on a specific persistence layer for a declared semantic) and diverges from TS/C#/Java, where the API surface already owns it.

### Precedent alignment

- **FR-036** (constraint validation must be enforced at the wire tier across all ports) is the same call for the sibling write semantic; `@autoSet` and constraint-validation even interlock (every port's insert schema already makes an `@autoSet @required` field optional-on-POST *because* the server fills it).
- **ADR-0023** (strict provenance) is unaffected: no new vocabulary, purely where a generator enforces an existing attr.
- Ships as a coordinated bug-fix change (Kotlin controller + Python router/model + the api-contract `@autoSet` gate), landed together so no lane reds — per the repo's "never commit a scenario ports can't pass" rule.
