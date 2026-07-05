# ADR-0041: Cross-package reference resolution contract

## Status

**Accepted** (2026-07-05).

## Context

Every metadata reference that names another object — `@objectRef` (relationship + `field.object`), `@references` (`identity.reference`), the `@from`/`@of`/`@via` heads of `origin.*`, `extends` (object/field/identity super-references), a relationship's `@through` junction, and the template/source refs `@payloadRef`/`@responseRef`/`@parameterRef` — may name a target in a **different package**. A reference is written either **fully-qualified** (`acme::crm::Customer`, or a member path `acme::crm::Customer.email`) or **bare** (`Customer`).

The five ports had **no shared, tested contract** for how a bare or FQN reference resolves when object names collide across packages, and **zero cross-package conformance fixtures**. That let real cross-port divergences hide:

- **Java** (`SymbolTable.nameMatches`, `ValidationPhase.nameMatches`) compared the reference's **bare tail** against bare names *before* the exact-FQN check. So an explicit, unambiguous FQN `acme::vendor::Customer` silently bound to `acme::crm::Customer` — the wrong package (wrong FK table in codegen). A fully-qualified reference — the *unambiguous* form — resolved to the wrong object.
- **Kotlin** (`KotlinGenUtil.resolveObjectByShortOrFqn`) resolved a bare colliding name to the first in load order — arbitrary, load-order-dependent.
- **TypeScript / C#** matched FQNs exactly (correct) but resolved a bare colliding name by arbitrary first/last-match, with no ambiguity signal.

Unique cross-package names resolved correctly everywhere, which is why the gap went unnoticed until a downstream model with same-named entities across packages exposed it.

## Decision

A single reference-resolution contract, identical in all five ports, applied wherever a reference names an object:

1. **A fully-qualified reference (contains `::`) resolves exactly.** It matches the object whose package-qualified resolution key equals the reference — and nothing else. It **never** falls back to a bare-tail match. An FQN that matches no object is the attribute's existing unresolved error (`ERR_INVALID_RELATIONSHIP` / `ERR_INVALID_ORIGIN` / `ERR_UNRESOLVED_SUPER` / …), never a silent mis-bind.

2. **A bare reference resolves by precedence:**
   - **(a) same package** — an object of that name in the **referrer's own package** wins;
   - **(b) unique elsewhere** — else exactly one object of that name across all packages resolves;
   - **(c) ambiguous** — else (more than one candidate across other packages, none in the referrer's package) is a hard load error, **`ERR_AMBIGUOUS_REF`** (new). The author must qualify with the FQN;
   - **(d) unresolved** — else (no candidate) is the attribute's existing unresolved error.

The "referrer's package" is the package of the node carrying the reference. This preserves every previously-working case (unique names, whether bare or FQN) and only changes collision behavior — from *silent, arbitrary, port-divergent mis-binding* to *deterministic same-package preference or a loud, portable error*.

## Consequences

- **New error code `ERR_AMBIGUOUS_REF`**, registered cross-port (added to each port's error-code set and `fixtures/conformance/ERROR-CODES.json`).
- **Resolvers become referrer-package-aware.** Each port routes object-reference resolution through one shared helper (`resolveObjectRef(root, ref, referrerPkg)` in TS) so relationship/reference/origin/extends/template resolution behave identically; the referrer's package is threaded to each call site. Java's bare-tail-before-FQN ordering (`SymbolTable.nameMatches`, `ValidationPhase.nameMatches`) and the Java codegen/runtime helpers that shared it (`SpringM2mSupport.findEntity`, `KotlinRenderHelperGenerator`, and the M:N FK-derivation SSOT `M2MFields` + runtime `M2MResolver`) are corrected to resolve FQNs exactly; `SpringPayloadGenerator`/`KotlinGenUtil` were already FQN-safe and unchanged. The remaining *bare*-collision same-package preference in codegen/runtime is a documented follow-up (#174).
- **Conformance-gated.** New `fixtures/conformance/` fixtures cover every ref-bearing attribute cross-package (unique-name working cases) plus the collision contract: FQN-exact-across-collision (via `extends`, observable in effective serialization), bare same-package preference, and bare-ambiguous → `ERR_AMBIGUOUS_REF`. All five ports must serialize/err byte-identically.
- **Breaking only for models that today rely on a bare reference silently binding to an arbitrarily-chosen same-named entity in another package** — previously undefined behavior, now an explicit `ERR_AMBIGUOUS_REF` that is fixed by qualifying the reference. No change for unique names or explicit FQNs.

See the cross-package conformance corpus (`fixtures/conformance/xpkg-*`, `error-xpkg-*`) for the executable contract.
