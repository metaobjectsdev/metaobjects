# #265 provenance-scoped strict attr scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is self-sufficient — every API/construction path a task needs is inlined; do NOT rely on an external "file map".

**Goal:** Make strict attribute scoping stop pruning consumer `registry.extend()` vocabulary, so all five ports byte-agree that extending a spec-declared core subtype and strict-loading metadata that uses it is valid — gated by new cross-port conformance fixtures.

**Architecture:** Stamp each per-type attr with the id of the provider that registered it; the FR-033 B2b prune (`applyStrictAttrScoping`) then drops only attrs contributed by the *library's own* providers, never consumer extensions. Add a Java `composeMetamodelRegistry(extraProviders)` seam so JVM consumer registries get the same (now provenance-safe) scoping instead of skipping it. Prove it with a new success-scenario shape in `provider-composition-conformance`, in a **subdirectory** so un-updated runners never see it.

**Tech Stack:** Python 3 (`metaobjects`), C# (.NET `MetaObjects`), Java 21 (`metaobjects-metadata`) + Kotlin (inherits JVM), TypeScript (reference — no product change). bun test / pytest / xUnit / JUnit4 conformance runners.

## Global Constraints

- PUBLIC repo — no private/other-project names, no absolute home paths in any committed file or commit message.
- **No new error codes.** `ERR_UNKNOWN_ATTR` (typos, misplaced core attrs) and `ERR_PROVIDER_ATTR_CONFLICT` (extend-time) unchanged.
- **`registry-conformance` manifest byte-match MUST stay unchanged** — the provenance guard only *spares* consumer attrs; library-only composition (which stamps everything with library ids or leaves it unstamped→library-default) is a no-op under the guard, so prune output incl. attr order is byte-identical.
- The strict *check* stays own-attrs-only (ADR-0039) — do NOT change check semantics.
- Named conformance providers are **test-only** — never in shipped metamodel providers.
- **Unstamped / build-time-enrichment registrations default to LIBRARY-origin (prunable).** Any missed stamping path degrades to *today's* behavior; the new fixtures catch a missed consumer-side stamp. Sentinel + library-id set are **named constants** per each port's constants discipline.
- Commit author + standard `Co-Authored-By` / `Claude-Session` trailers per repo convention.
- Design doc: `docs/superpowers/specs/2026-08-02-issue-265-strict-scoping-provenance-design.md`.

## File Structure

- **Shared fixtures** in a NEW subdir `fixtures/provider-composition-conformance/compose-load/`: `extend-spec-subtype-registry.json`, `extend-spec-subtype-strict-load.json`, `extend-spec-subtype-typo-rejected.json`, `misplaced-core-attr-consumer-registry.json`. The flat corpus dir stays **error-shape-only** (its 5 existing manifests unchanged). README documents the subdir + why (older-runner compatibility — all four runners list the corpus dir NON-recursively and hard-require the old shape, so a new-shape manifest in the flat dir would red every un-updated runner).
- **TS runner** (reference) `server/typescript/packages/metadata/test/provider-composition-conformance.test.ts`. No product change.
- **Python** product: `provider.py`, `registry.py`, `spec_metamodel/__init__.py`, `core_types.py`; runner `tests/conformance/test_provider_composition_conformance.py`.
- **C#** product: `MetaObjects/Provider.cs`, `MetaObjects/Registry.cs`, near `Loader/MetaDataLoader.cs` `DefaultRegistry`; runner `ProviderCompositionConformanceTests.cs`.
- **Java** product: `MetaDataRegistry.java`, `RegistryManifest.java`; runner `ProviderCompositionConformanceTest.java` (covers Kotlin).

## Manifest-shape extension (used by all tasks)

The existing error-code manifests (`{description, providers[], expectedError, sealThenRegister?}`) are UNCHANGED. Every runner update must make `expectedError` **optional** and **dispatch on shape** (presence of the new keys). New OPTIONAL keys for the `compose-load/` subdir scenarios:

```jsonc
{
  "description": "...",
  "providers": ["extend-spec-subtype"],   // named test providers, composed AFTER the library core set
  "composeWithCore": true,                  // compose the port's LIBRARY provider set first, then `providers`
  "expectAttrs": {                          // OPTIONAL registry-inspection: the port's declared-attr lookup its strict check uses
    "type": "view", "subType": "currency", "contains": ["locale", "decimals"]
  },
  "metadata": { "metadata.root": { ... } }, // OPTIONAL canonical-JSON doc to strict-load
  "expectErrors": ["ERR_UNKNOWN_ATTR"]      // OPTIONAL error codes the strict load must surface ([] = expect success)
}
```

Runner behavior: if `composeWithCore`, compose `[...libraryProviders, ...named]`; else today's named-only. If `expectAttrs`, assert the port's declared-attr set for `(type,subType)` ⊇ `contains` (flat lookup in TS/Python/C#; Java via `typeDef.getChildRequirement(name)`, direct-or-inherited). If `metadata`, strict-load it and assert the surfaced `.code`s equal `expectErrors` (order-insensitive; `[]` = zero errors).

**Canonical named provider `extend-spec-subtype`:** id `"extend-spec-subtype"`, **no dependencies** (the provider that registers `view.currency` has a different id per port, and the corpus mandates identical id/deps across ports — so ordering is guaranteed by the `composeWithCore` contract [library set first, named appended; every port's compose is a stable topo-sort preserving input order], NOT by a declared dep). `registerTypes` extends `view.currency` with one **int** attr `decimals`. Note in the README that `composeWithCore` is the sanctioned exception to Python's "extenders MUST declare a dependency" docstring.

**The strict-load metadata docs** (fixtures 2/3/4): a `metadata.root` with one `object.entity` carrying an `identity.primary` (so the doc is otherwise clean), and:
- fixtures 2/3: a **`field.currency`** field (that is where a `view.currency` child is structurally admitted; `@currency` may be omitted — optional, default USD) with a `view.currency` child carrying `@decimals: 2` (fixture 2) / `@decimalz: 2` (fixture 3).
- fixture 4: a **`field.boolean`** field carrying `@maxLength: 5` (a misplaced core attr).

**Per-runner strict-load construction** (inline — do NOT reach for a `fromString`-style factory blindly; only TS/Python have strict+registry factories):
- **TS**: `MetaDataLoader.fromString(doc, "json", { registry, strict: true })` (`LoadOptions` carries both).
- **Python**: `MetaDataLoader.from_string(content, providers=[*core_providers, extend_provider], strict=True)` (the loader takes *providers*, not a registry). `expectAttrs` uses `compose_registry([*core_providers, extend_provider]).attrs_of(type, subType)`.
- **C#**: `new MetaDataLoader(registry, strict: true)` then `loader.Load(new IMetaDataSource[]{ new InMemoryStringSource(doc, format: Json) })` — `FromString`/`FromDirectory` have NO strict+inline path.
- **Java**: `new MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, name)` → `setTypeRegistry(composedRegistry)` **before** `init()` → `init()` → `load(List.of(new InMemoryStringSource(content, "<inline>", format)))` → collect codes from `getErrors()`.

The four fixtures:
1. `extend-spec-subtype-registry`: `composeWithCore`, `providers:["extend-spec-subtype"]`, `expectAttrs:{view,currency,contains:[locale,decimals]}`.
2. `extend-spec-subtype-strict-load`: + `metadata` (field.currency w/ `view.currency @decimals:2`), `expectErrors:[]`.
3. `extend-spec-subtype-typo-rejected`: + `metadata` (`@decimalz:2`), `expectErrors:["ERR_UNKNOWN_ATTR"]`.
4. `misplaced-core-attr-consumer-registry`: `composeWithCore`, `providers:["extend-spec-subtype"]`, `metadata` (field.boolean w/ `@maxLength:5`), `expectErrors:["ERR_UNKNOWN_ATTR"]`.

---

### Task 1: Subdir fixtures + TS reference lane (all green)

**Files:** the 4 fixtures under `compose-load/` + README (create/modify); TS runner (modify — no product change).

- [ ] **Step 1: Write the 4 fixture JSONs** in `fixtures/provider-composition-conformance/compose-load/` exactly per the shape + metadata-doc rules above. Verify each `metadata` body is valid canonical JSON.
- [ ] **Step 2: Extend `README.md`** — document the `compose-load/` subdir (+ why: non-recursive older-runner compatibility), the new keys (`composeWithCore`/`expectAttrs`/`metadata`/`expectErrors`), the `extend-spec-subtype` named-provider entry (id/no-deps/registers `decimals` on `view.currency`), and the `composeWithCore`-vs-"extenders-must-declare-a-dep" exception note.
- [ ] **Step 3: Extend the TS runner** — glob the `compose-load/` subdir too; make `expectedError` optional + dispatch on shape; add `extend-spec-subtype` (`registry.extend("view","currency", <int attr "decimals">)`); implement compose-with-core (`coreProviders`), the `expectAttrs` assertion, and strict-load via `MetaDataLoader.fromString(doc, "json", { registry, strict: true })` collecting `.code`s.
- [ ] **Step 4: Run TS** — `cd server/typescript && bun test packages/metadata/test/provider-composition-conformance.test.ts`. Expected: **all 4 green** (TS = reference: extension survives, `@decimals` accepted, `@decimalz` + misplaced `@maxLength` rejected). If any fail, the fixture/runner is wrong — fix before proceeding (TS defines correct behavior).
- [ ] **Step 5: Commit** `test(#265): compose-load conformance subdir + 4 extend-subtype fixtures (TS reference green)`.

---

### Task 2: Python — RED baseline, then provenance fix

**Files:** runner `test_provider_composition_conformance.py`; `provider.py`, `registry.py`, `spec_metamodel/__init__.py`, `core_types.py`.

- [ ] **Step 1: Extend the Python runner** — scan the `compose-load/` subdir; `expectedError` optional + shape dispatch; add `extend-spec-subtype`; compose-with-core = `[*core_providers, extend_provider]` (NOTE: `core_providers` is a LIST at `core_types.py`, not a callable — no `()`); `expectAttrs` via `compose_registry([...]).attrs_of(...)`; strict-load via `MetaDataLoader.from_string(content, providers=[*core_providers, extend_provider], strict=True)` collecting `.code`s.
- [ ] **Step 2: Run — RED baseline.** `cd server/python && uv run pytest tests/conformance/test_provider_composition_conformance.py -k extend -q`. Expected: fixtures 1,2,3 **FAIL** (the prune deletes `decimals`); fixture 4 passes. This is the confirmed #265 repro as a gated test.
- [ ] **Step 3: Stamp provenance at registration.** `provider.py` compose loop: set `registry._current_provider_id = p.id` around each `register_types`, clear after (finally). `registry.py` `register`/`extend`: record `(type, subType, attr_name) -> current_provider_id` in a registry side-map; NO current id → the `_LIBRARY` sentinel constant.
- [ ] **Step 4: Library-id set constant.** In `core_types.py` expose a frozen `LIBRARY_PROVIDER_IDS` = the ids of the core/db/doc/prompt/ui library providers (named constant).
- [ ] **Step 5: Guard the prune.** In `_apply_strict_attr_scoping` (`spec_metamodel/__init__.py`): drop iff `prunable AND name not in allow AND (origin is _LIBRARY or origin in LIBRARY_PROVIDER_IDS)` — a consumer-origin attr is never pruned; an unstamped/build-time attr (origin `_LIBRARY`) still prunes (today's behavior).
- [ ] **Step 6: Run — GREEN.** Same `-k extend` command → all 4 pass. Then `cd server/python && uv run pytest -q` full suite, and confirm `registry-conformance` byte-match unchanged.
- [ ] **Step 7: Commit** `fix(#265): provenance-scoped strict attr prune (Python) — spare consumer extends`.

---

### Task 3: C# — RED baseline, then provenance fix (mirror Python)

**Files:** runner `ProviderCompositionConformanceTests.cs`; `Provider.cs`, `Registry.cs`, near `DefaultRegistry`.

- [ ] **Step 1: Extend the C# runner** — scan `compose-load/`; `ExpectedError` optional + shape dispatch; `extend-spec-subtype`; compose-with-core = the 4 `DefaultRegistry` library providers + named; `expectAttrs` via `AttrsOf`; strict-load via `new MetaDataLoader(registry, strict: true)` + `loader.Load(new IMetaDataSource[]{ new InMemoryStringSource(doc, format: Json) })` collecting codes.
- [ ] **Step 2: Run — RED.** `cd server/csharp && dotnet test --filter ProviderComposition`. Expected: fixtures 1,2,3 FAIL (live confirmation C# shares the prune — was code-read-only); 4 passes.
- [ ] **Step 3: Stamp provenance** — `Provider.cs::ComposeRegistry` sets a `CurrentProviderId` around each provider; `Registry.cs::Register`/`Extend` record `(type,subType,attr) -> id`; no-current → `LibrarySentinel` constant.
- [ ] **Step 4: Library-id set constant** beside `Loader/MetaDataLoader.cs::DefaultRegistry` (the four provider ids).
- [ ] **Step 5: Guard the prune** — `Registry.cs::ApplyStrictAttrScoping`: `... AND (origin == LibrarySentinel || LibraryProviderIds.Contains(origin))`.
- [ ] **Step 6: Run — GREEN** + full C# suite + `registry-conformance` byte-match unchanged.
- [ ] **Step 7: Commit** `fix(#265): provenance-scoped strict attr prune (C#) — spare consumer extends`.

---

### Task 4: Java/Kotlin — consumer-path seam (scaffolding) then provenance fix

**Files:** runner `ProviderCompositionConformanceTest.java`; `MetaDataRegistry.java`, `RegistryManifest.java`.

- [ ] **Step 1: Add the seam FIRST (scaffolding, not the fix).** Add `RegistryManifest.composeMetamodelRegistry(Collection<MetaDataTypeProvider> extra)`: compose `metamodelProviders() + extra` → `getAllValidationConstraints()` → `applySpecDescriptions(SpecMetamodelReader.load())` → return **unsealed** (caller may seal). Document it as the `MetaDataLoader.setTypeRegistry(...)` seam. Raw `MetaDataRegistry.compose(...)` unchanged. (This only routes the consumer path THROUGH scoping — the prune is still provenance-blind until Steps 4-5.)
- [ ] **Step 2: Extend the Java runner** — scan `compose-load/`; `expectedError` optional + shape dispatch; add `extend-spec-subtype` as `registry.extendType(com.metaobjects.view.CurrencyView.class, def -> def.optionalAttribute("decimals", <int attr subType>))` (`view.currency` is registered by `CurrencyView.registerTypes`; `optionalAttribute(name, subType)` exists on `TypeDefinitionBuilder`; model on `CoreDBMetaDataProvider`'s attr registrations). `composeWithCore` composes via **`composeMetamodelRegistry(List.of(extendProvider))`** (the seam — the path adopters use), NOT raw `compose()`. Strict-load recipe: `new MetaDataLoader(LoaderOptions.create(false,false,true), SUBTYPE_MANUAL, name).setTypeRegistry(composed)` **before** `init()`, then `load(List.of(new InMemoryStringSource(content, "<inline>", Json)))`, collect `getErrors()` codes.
- [ ] **Step 3: Run — RED baseline.** `cd server/java && mvn -q -pl metadata test -Dtest=ProviderCompositionConformanceTest`. Expected: **fixtures 1,2,3 FAIL** (the provenance-blind prune eats `decimals` — live proof Java shares the prune bug, previously PLAUSIBLE-only); **fixture 4 GREEN** (the seam routes the misplaced `@maxLength` through scoping → correctly `ERR_UNKNOWN_ATTR`; note fixture 4 is a **regression lock for the seam**, not a red-first test).
- [ ] **Step 4: Stamp provenance.** `MetaDataRegistry.registerProviders` sets `currentProviderId` around each `provider.registerTypes(this)`. Hook **both** registration entry points: (a) `register(...)` records `(type,subType,attrName) -> id` for its attr requirements; (b) `extendType(Class, Consumer)` is class-keyed and rebuilds via `TypeDefinitionBuilder.from(existing)` writing straight into `typeDefinitions` **without** `register()` — after `build()`, **diff** the attr-typed direct-requirement names against `existing`'s and stamp ONLY the NEW names with `currentProviderId` (blanket-stamping would mis-attribute pre-existing library attrs; a same-name redefinition keeps its prior origin). Build-time / constraint-expansion copies (no current id) → `_LIBRARY` sentinel. Derive the library-id set at runtime from `RegistryManifest.metamodelProviders()` (each `getProviderId()`), as a memoized constant.
- [ ] **Step 5: Guard the prune.** `applyStrictAttrScoping`: on BOTH the direct AND inherited requirement maps, the drop clause gains `&& isLibraryOrigin(id.type(), id.subType(), req.getName())` where `isLibraryOrigin` = stamped by a `metamodelProviders()` id OR unstamped (`_LIBRARY`). Inherited copies are unstamped at the child key → library-origin → still prune (correct — they originate from library base registrations; this is the intended convergent behavior). `isPrunableAttr` unchanged.
- [ ] **Step 6: Run — GREEN** — `ProviderCompositionConformanceTest` all 4 green (Kotlin inherits via the JVM runner). Then `mvn -q -pl metadata test` full, and confirm the sealed default `composeMetamodelRegistry()` (no extras) emits the **byte-identical** `registry-conformance` manifest.
- [ ] **Step 7: Commit** `fix(#265): provenance-scoped prune + composeMetamodelRegistry(extras) seam (Java/Kotlin)`.

---

### Task 5: Verify + docs + review + PR

- [ ] **Step 1: Cross-port green.** Run all four runners; the 4 fixtures green in TS/Python/C#/Java(+Kotlin). Confirm `registry-conformance` manifest byte-match unchanged in every port.
- [ ] **Step 2: Docs.** Update `docs/features/extending-with-providers.md` with a note that extend-under-strict is conformance-gated (and, for Java adopters, the `setTypeRegistry(composeMetamodelRegistry(extras))` seam). The design doc's non-goals already record: the core-attr-name `ERR_PROVIDER_ATTR_CONFLICT` residual, the **B2a structural-children twin** (provenance-blind for consumer child-rule extends — same class, out of scope, will re-file structurally), and the convergent base-subtype behavior — verify those are present.
- [ ] **Step 3: Per-unit review** — code-reviewer + code-simplifier on the diff; fix findings in place.
- [ ] **Step 4: no-mistakes gate** — rich `--intent` (the three-way divergence; provenance mechanism incl. the unstamped→library default; the Java two-entry-point diff-stamp; the deliberate registry-conformance-unchanged invariant; the B2a residual). Ensure `.serena/` + `.worktrees/` in `.git/info/exclude`.
- [ ] **Step 5: PR** — `Closes #265`; body: the three-way divergence table, the provenance fix, the Java consumer-path fold-in, the 4 conformance fixtures (in the `compose-load/` subdir), the accepted residuals (core-attr-name conflict + B2a structural twin), and that #267 unblocks on this. **Coordinated cross-port patch** (PyPI + NuGet + Maven; npm reference-only, no product change) — flag that the release is coordinated when Doug cuts it.

## Self-Review

- **Spec coverage:** provenance stamp + guard (Python T2 / C# T3 / Java T4) ✓; Java consumer-path seam (T4 S1) ✓; 4 conformance fixtures + shape, in a subdir so un-updated runners stay green (T1, exercised T2–T4) ✓; TS reference lane (T1) ✓; registry-conformance-unchanged invariant asserted per port (T2/T3/T4 step 6, T5 step 1) ✓; accepted residuals documented (design + T5) ✓; batch note re #267 (T5) ✓.
- **No placeholders:** every construction/API path (strict-load per port, Java two-entry-point diff-stamp, the seam signature, the fixture metadata-doc rules, the unstamped→LIBRARY default) is inlined above — the plan is self-sufficient for fresh per-task subagents.
- **Type consistency:** `extend-spec-subtype` (no-deps, `decimals` on `view.currency`) + the manifest keys (`composeWithCore`/`expectAttrs`/`metadata`/`expectErrors`, `expectedError` now optional) are defined once (shape section) and consumed identically by all five runners; `composeMetamodelRegistry(extra)` (T4 S1) is consumed by the Java runner (T4 S2).
