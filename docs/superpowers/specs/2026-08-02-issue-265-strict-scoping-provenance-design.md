# #265 — strict attr scoping must not prune consumer `registry.extend()` vocabulary: design

_Date: 2026-08-02 · Issue: [#265](https://github.com/metaobjectsdev/metaobjects/issues/265) · Scope: cross-port loader (Python + C# + Java product; TS is the reference) + a new conformance corpus shape · Status: designed (Fable cross-port investigation + live Python/TS repro)_

## Problem — a three-way cross-port divergence (not "Python only")

On identical input — the library core providers **plus** a consumer provider that `registry.extend()`s a **spec-declared** core subtype with one extra attr (`@decimals` on `view.currency`), then strict-loading metadata that uses it — the five ports disagree:

| Port | Behavior | Correct? |
|---|---|---|
| **TypeScript** | **Accepts** — no spec-scoping prune step exists | ✅ reference behavior (reproduced live) |
| **Python** | **Rejects** `ERR_UNKNOWN_ATTR` — the prune deletes the extension | ❌ the bug (reproduced live) |
| **C#** | **Rejects** — line-for-line the same compose-then-prune | ❌ same bug (code-read) |
| **Java / Kotlin** | **Accepts** — but only because the consumer-composed registry **skips spec scoping entirely** | ❌ a *second* bug: JVM consumer registries get a **weaker** strict mode (they also wrongly accept a misplaced core attr) |

`#265`'s "Python port only" scope is wrong: **Python + C# share the prune bug; Java/Kotlin have the complementary no-scoping-on-consumer-path bug; TS is the reference.** The only workaround today (`--lax`) disables unknown-attr checking for the **whole file**, so an adopter who follows the documented "extend the registry for app vocabulary" path (`docs/features/extending-with-providers.md`) ends up with a permanently weaker gate.

## Root cause

FR-033 sub-step B2b's `applyStrictAttrScoping` (Python `_apply_strict_attr_scoping`, C# `ApplyStrictAttrScoping`, Java `applyStrictAttrScoping`) is a **port-alignment shim**: it trims each port's legacy over-broad attr registrations down to the spec-exact per-subtype graph so the registry-conformance manifest byte-matches `expected-registry.json` and a misplaced core attr (`@maxLength` on `field.boolean`) stays `ERR_UNKNOWN_ATTR`. It prunes any prunable attr whose **name** is not in the shipped spec allow-list — **blind to who registered it** — so it also deletes consumer `registry.extend()` extensions. TS needs no shim because its providers already register spec-exact vocabulary.

**The strict *check* is not the bug.** Every port's strict check is deliberately own-attrs-only (ADR-0039: an inherited attr is validated once, at its declaring node), so metadata-level `extends` inheritance already works. The maintainer's "look it up the extends tree" is satisfied by **restoring the provider-registered vocabulary to the registry** — no check-semantics change (an abstract parent declaring the attr would fail identically today, because the *registry* lacks it for the subtype; tree-walking the check cannot fix a pruned registry).

## Intended contract

Strict load = **membership in the composed registry's declared vocabulary** (ADR-0023). An authored own `@attr` is legal iff a *registered* provider — library **or downstream** — declared it for that `(type, subType)`, or it is a `commonAttr`, or it is an `attr.properties` bag. The spec allow-list constrains **only what the library's own providers contribute**; consumer registrations always survive; all five ports byte-agree; required attrs stay enforced and genuine typos stay rejected.

## Decision — provenance-scoped prune (+ close the Java consumer-path gap)

Record the **contributing provider id** per per-type attr at registration; B2b prunes only attrs contributed by the **library's own** metamodel providers.

- Compose loop sets a `currentProviderId` around each `provider.registerTypes(registry)`; `register`/`extend` stamp it into a side map keyed `(type, subType, attrName)` (no change to the frozen attr-schema types). Attrs registered outside any compose loop (build-time enrichment) default to **library-origin**.
- The prune condition gains one clause: prunable **AND** not-in-allow-list **AND** origin ∈ library-provider-id set. Each port already owns that set (Python `core_providers`; C# the four in `MetaDataLoader.DefaultRegistry`; Java `RegistryManifest.metamodelProviders()`; TS `coreProviders`).
- **Java consumer-path fix:** add a `RegistryManifest.composeMetamodelRegistry(extraProviders)` overload (compose core + extras → force constraints → `applySpecDescriptions`, now provenance-safe) and document it as the sanctioned `MetaDataLoader.setTypeRegistry(...)` seam, so JVM consumer registries get the SAME tightening every other port has. Raw `MetaDataRegistry.compose(...)` keeps today's semantics (tests rely on partial sets). Kotlin inherits both for free.

**Rejected alternatives.** (c) *No prune; resolve allowance at check time* — the pruned registry is the single vocabulary truth read by the manifest emitters, docs-gen, YAML desugar, and allowedValues validation; special-casing only the check re-opens the misplaced-attr hole or needs the same provenance in more places. *Reorder (scope after library, before consumer providers)* — behaviorally equivalent for the standard `[*core, *mine]` list and simpler, but needs the same library-membership knowledge, mis-classifies an interleaved provider, and cannot express the Java fix (Java's scoping isn't in `compose()`). Provenance is strictly more robust.

**No new error codes.** `ERR_UNKNOWN_ATTR` still fires for typos and misplaced core attrs; `ERR_PROVIDER_ATTR_CONFLICT` unchanged at extend time.

## Per-port touch list

- **Python**: `provider.py` (compose loop stamps id), `registry.py` (`register`/`extend` record origin), `spec_metamodel/__init__.py::_apply_strict_attr_scoping` (origin guard), `core_types.py` (export the frozen library-id set).
- **C#**: `MetaObjects/Provider.cs` (ComposeRegistry loop), `MetaObjects/Registry.cs` (`Register`/`Extend` record + `ApplyStrictAttrScoping` guard), library-id set beside `DefaultRegistry`.
- **Java**: `MetaDataRegistry.registerProviders` (stamp id) + `applyStrictAttrScoping` (origin guard on direct AND inherited maps); new `RegistryManifest.composeMetamodelRegistry(extraProviders)` overload; docs for the `setTypeRegistry` seam. Kotlin inherits.
- **TypeScript**: no product change — it is the semantics target and the reference lane of the new conformance scenarios.

## Conformance — the gap that let this ship, and its fix

**Why unseen:** no corpus composes a *consumer* provider and then strict-loads. `provider-composition-conformance` asserts error codes at compose time only, and its one extending provider deliberately registers a **fresh non-spec subtype** (dodging the prune); `registry-conformance` composes library providers only (a consumer attr would break its byte-match by design); the sole `ERR_UNKNOWN_ATTR` fixture holds only the negative case.

**Home:** `fixtures/provider-composition-conformance/` (its five runners already have the named-provider machinery). Extend the manifest shape with success scenarios: `"composeWithCore": true` (compose the port's library provider set first) + an optional `"metadata"` + `"expect"` block (strict-load an embedded doc; assert error codes only, per corpus convention). New canonical named provider `extend-spec-subtype` extends `view.currency` with one `int` attr `decimals`.

Four fixtures:
1. **`extend-spec-subtype-registry`** — compose core + provider; assert `attrsOf("view","currency")` contains BOTH `locale` and `decimals`. (Fails today on Python + C#; passes TS + Java → catches the bug AND the divergence.)
2. **`extend-spec-subtype-strict-load`** — strict-load a doc with `@decimals` on a `view.currency`; expect zero errors. (The end-to-end #265; fails today on Python/C#.)
3. **`extend-spec-subtype-typo-rejected`** — strict-load `@decimalz`; expect exactly `ERR_UNKNOWN_ATTR`. (Guards against over-correcting — typo-catching stays intact on an extended subtype.)
4. **`misplaced-core-attr-consumer-registry`** — strict-load `@maxLength` on a `field.boolean`; expect `ERR_UNKNOWN_ATTR` in ALL ports. (Catches the **Java** flavor — its consumer-path registry never got B2b — and forces the `composeMetamodelRegistry(extras)` routing.)

Fixtures 1 + 4 together catch both the bug and all three divergent behaviors in the existing five-port gate.

## Accepted residual / non-goals

- **Extending a subtype with a core-attr *name* the port legacy-registers broadly** (e.g. `@maxLength` onto `field.boolean` via `extend`) throws `ERR_PROVIDER_ATTR_CONFLICT` on Python/C#/Java but succeeds on TS (whose registry never had it there). The deep fix — every port registers exactly-per-spec and the prune is deleted — is the eventual end state but a large per-port registration refactor; **out of scope for #265**, documented as a known residual.
- No change to the strict *check* semantics (own-only is correct, ADR-0039). No new error codes. No metamodel vocabulary change.

## Batch context

- **#267** (Python declarative codegen config) formalizes the exact `--provider module:symbol` path #265 breaks — **fix #265 first** or #267 ships a broken sanctioned path.
- **#266** (codegen-ts enums.ts path collision) and **#258** (migrate PK-change kind) do not interact.
- The Java consumer-path weaker-strict bug is folded into this fix (not filed separately).

## Verification

- Reproduce the bug in a **failing test first** in each affected port (Python + C# + Java) — Fable executed only Python + TS; C#/Java behavior is code-read and must be confirmed by a red test before the fix.
- The 4 conformance fixtures green in all five port runners (TS unchanged, Python/C#/Java fixed).
- Existing `registry-conformance` manifest byte-match unchanged (library-only composition is untouched by a provenance guard that only *spares* consumer attrs).
- Full metadata/loader suites green per port.
