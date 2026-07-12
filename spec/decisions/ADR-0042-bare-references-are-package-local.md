# ADR-0042: Bare references are package-local

## Status

**Accepted** (2026-07-12). **Amends [ADR-0041](ADR-0041-cross-package-reference-resolution.md)** — supersedes its Decision §2(b) "unique elsewhere" and §2(c) `ERR_AMBIGUOUS_REF`. ADR-0041 §1 (FQN-exact) and §2(a) (same-package preference) stand. Aligns with **[ADR-0032](ADR-0032-canonical-fqn-refs.md)**.

**Implementation status: in progress** (as of 2026-07-12). The decision is accepted; the coordinated 5-port implementation is not yet merged. The TS reference-port core (the source-agnostic bare→FQN fold at load + package-local resolvers) is validated (2100/2125 metadata tests; the remainder are the expected golden/accessor updates). Fixes #191, closes #174 (superseded). See the implementation plan for the remaining work (TS golden regen + the other four ports + release).

## Context

ADR-0041 (accepted one week earlier) gave a bare reference three resolution behaviors: (a) prefer the referrer's own package, else (b) resolve to a same-named object in **any other package** as long as it is globally unique ("unique-anywhere"), else (c) `ERR_AMBIGUOUS_REF`. Sub-rule (a) and the FQN-exact rule (§1) are sound and stay. Sub-rule (b) — a bare ref silently binding across a package boundary — is the mistake this ADR corrects.

The evidence against unique-anywhere:

1. **It contradicts an earlier accepted ADR.** [ADR-0032](ADR-0032-canonical-fqn-refs.md) (accepted 2026-06-13, three weeks before ADR-0041, flagged a pre-1.0 blocker) already decided: *"bare `Name` → the current package only; never a root fallback… Canonical JSON is fully-qualified… the JSON loader and resolution layer do pure FQN match."* ADR-0032 assembled the prior art (PEP 328 removing implicit relative imports, Rust RFC 2126, C++ `::` / C# `global::`, protobuf FQNs) and concluded **no fallback**. ADR-0041 §2(b) legislated resolution for a ref shape ADR-0032 had already declared ill-formed. The two contradict; ports implemented different halves.

2. **It is fragile / non-monotonic.** Whether a bare ref resolves — and *to what* — depends on the global package set. Adding a same-named object in another package can silently re-bind an existing ref (same-package preference beats unique-anywhere) or turn a working model into an error. A distant, unrelated file changes the meaning of this one — action-at-a-distance in a system whose spine is durable metadata. (The same class of defect the loader-order fix in #188 removed one level down: "resolution must be a pure function of the source *set*, not load order"; unique-anywhere makes resolution a function of the *package set*.)

3. **It could not be implemented identically.** One week after a coordinated, conformance-gated rollout, the five ports exhibited at least five distinct bare-ref behaviors (issue **#191**): the YAML desugar in all four desugar ports folds `bare → current-package` *before* resolution (so unique-anywhere is dead code on the primary authoring path), while the loader ambiguity pass, the binding sites, `extends`, `@through`, and several codegen/runtime resolvers each resolved bare refs differently. #191 (a bare cross-package `field.object @objectRef` loading clean in TS but dangling in Python) and the open follow-up **#174** (same-package preference never threaded through the binding sites) are both symptoms.

4. **Zero conformance coverage + docs already teach the opposite.** No fixture exercises unique-anywhere *passing*; every "cross-package works" fixture uses FQNs. The shipped docs and agent-context authoring skill already state the rule this ADR adopts (`docs/features/abstracts-and-inheritance.md`: "cross-package references use fully-qualified names… same-package references can use the bare name").

5. **It fights the house principles** — ADR-0037 (self-documentation over economy: the ref hides which package it means), ADR-0023 (fail-closed: silent cross-package binding is fail-open), ADR-0029 §5 ("the human decides exactly when ambiguity is introduced" — refused even for the narrower `@via` single-hop case), and ADR-0032 (directly).

## Decision

A single reference-resolution contract, identical in all five ports, applied wherever a reference names an object:

1. **A fully-qualified reference (contains `::`) resolves exactly** on the object's resolution key (`<package|fileDefaultPackage>::<name>`). It never falls back to a bare-tail match. (Unchanged from ADR-0041 §1.)

2. **A bare reference (no `::`) resolves in the referrer's package only.** It matches an object whose resolution key *is* the bare name — i.e. an object in the referrer's own package, or a **root-level** (empty-package) object whose resolution key is the bare name. There is **no** cross-package bare resolution, **no** globally-unique scan, **no** first-match, **no** bare-tail fallback.

3. **Every cross-package reference must be fully qualified.** The YAML authoring sugar is unchanged (ADR-0032 §2): bare `Name` → `<currentPkg>::Name`; `pkg::Name` absolute; `::Name` root-escape; `..::` parent-relative. The desugar remains the single place sugar lives; after desugar every canonical-JSON ref is a literal FQN (or bare only for a root-level object).

4. **The rule is uniform across every ref-bearing attribute:** `@objectRef` (relationship, `field.object`, `field.map`), `@references` (`identity.reference`), the `@from`/`@of`/`@via` heads of `origin.*`, `@payloadRef` / `@responseRef` / `@parameterRef`, and a relationship's **`@through`** — which is brought into the ref set and desugar-expanded like the others (ending its prior FR-032 exclusion). **`extends` is unchanged** — its super-resolver is already same-package-then-root-strict.

5. **An unresolved reference is a hard load error**, per attribute, with a did-you-mean hint listing same-short-name objects in other packages (e.g. `@objectRef 'app::a::Thing' … does not resolve. An object named 'Thing' exists in: app::b. Qualify it (e.g. 'app::b::Thing').`). Each attr keeps its existing unresolved code (`ERR_INVALID_RELATIONSHIP` / `ERR_INVALID_REFERENCE` / `ERR_INVALID_ORIGIN` / `ERR_INVALID_TEMPLATE` / `ERR_PARAMETER_REF_UNRESOLVED` / `ERR_UNRESOLVED_SUPER`); a `field.object`/`field.map` `@objectRef` — the one ref-bearing attr with no dangling-target check today — gains **`ERR_UNRESOLVED_OBJECT_REF`** (new).

6. **`ERR_AMBIGUOUS_REF` is retired.** With bare = package-local, ambiguity is unreachable: within one package, overlay-merge already guarantees name uniqueness.

## Consequences

- **Error codes:** retire `ERR_AMBIGUOUS_REF`, add `ERR_UNRESOLVED_OBJECT_REF`, both cross-port + `fixtures/conformance/ERROR-CODES.json`.
- **Resolution simplifies to a single matcher** — resolution-key equality — deleting the bare-tail fallbacks, first-match binders, and the referrer-package ambiguity passes across all ports. The change is mostly *removal*; the contract gets smaller.
- **Fixes #191** (both facets — the dangling `field.object @objectRef` now fails closed at load with a clear message; the Python payload bare-tail fallback is deleted) and **closes #174 as superseded** (the same-package-preference residual disappears — a bare ref is package-local, so there is nothing to prefer).
- **Resolves the ADR-0032 / ADR-0041 contradiction** — the loader/resolution layer now matches the desugar layer and ADR-0032.
- **Conformance-gated:** new/changed fixtures — `error-xpkg-ambiguous-objectref` re-expects the per-attr unresolved code; new `error-xpkg-bare-unique-elsewhere`, `error-field-objectref-unresolved` (+ `field.map`), `xpkg-through-fqn` / `error-xpkg-through-bare`, and a positive bare-same-package guard proving load-order independence. All five ports err/serialize byte-identically.
- **Breaking only for** models relying on previously-divergent behavior: a bare *packaged* cross-package ref in hand-written canonical JSON, unique-anywhere resolution, or the one-week-old `ERR_AMBIGUOUS_REF`. **No port-portable YAML-authored model changes meaning** (its bare refs already fold to the current package). The unresolved error hands the author the exact FQN to write.
- **Pre-1.0 mandatory.** GA promotion is the next release move; freezing unique-anywhere into Metamodel 1.0 would make the fragility permanent and let FR-034's multi-system composition (1.1) inherit it. Ships as a coordinated cross-port release on the current line with an explicit BREAKING CHANGELOG banner.

See the cross-package conformance corpus (`fixtures/conformance/xpkg-*`, `error-xpkg-*`) for the executable contract.
