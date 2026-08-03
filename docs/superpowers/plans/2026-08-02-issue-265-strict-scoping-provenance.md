# #265 provenance-scoped strict attr scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make strict attribute scoping stop pruning consumer `registry.extend()` vocabulary, so all five ports byte-agree that extending a spec-declared core subtype and strict-loading metadata that uses it is valid — gated by new cross-port conformance fixtures.

**Architecture:** Stamp each per-type attr with the id of the provider that registered it; the FR-033 B2b prune (`applyStrictAttrScoping`) then drops only attrs contributed by the *library's own* providers, never consumer extensions. Add a Java `composeMetamodelRegistry(extraProviders)` seam so JVM consumer registries get the same (now provenance-safe) scoping instead of skipping it. Prove it with a new success-scenario shape in `provider-composition-conformance`.

**Tech Stack:** Python 3 (`metaobjects`), C# (.NET `MetaObjects`), Java 21 (`metaobjects-metadata`) + Kotlin (inherits JVM), TypeScript (reference — no product change). JUnit4 / pytest / xUnit / bun test conformance runners.

## Global Constraints

- PUBLIC repo — no private/other-project names, no absolute home paths in any committed file or commit message.
- **No new error codes.** `ERR_UNKNOWN_ATTR` (typos, misplaced core attrs) and `ERR_PROVIDER_ATTR_CONFLICT` (extend-time) unchanged.
- **`registry-conformance` manifest byte-match MUST stay unchanged** — a provenance guard only *spares* consumer attrs; library-only composition is untouched.
- The strict *check* stays own-attrs-only (ADR-0039) — do NOT change check semantics.
- Named conformance providers are **test-only** — never in shipped metamodel providers.
- Metamodel strings via each port's constants; no `own*()` misuse.
- Commit author + standard `Co-Authored-By` / `Claude-Session` trailers per repo convention.
- Design doc: `docs/superpowers/specs/2026-08-02-issue-265-strict-scoping-provenance-design.md`.

## File Structure

- **Shared fixtures** `fixtures/provider-composition-conformance/`: `extend-spec-subtype-registry.json`, `extend-spec-subtype-strict-load.json`, `extend-spec-subtype-typo-rejected.json`, `misplaced-core-attr-consumer-registry.json`, + `README.md` shape doc extension.
- **TS runner** (reference) `server/typescript/packages/metadata/test/provider-composition-conformance.test.ts` — add `extend-spec-subtype` named provider + handle new manifest keys. No product change.
- **Python** product: `provider.py`, `registry.py`, `spec_metamodel/__init__.py`, `core_types.py`; runner `tests/conformance/test_provider_composition_conformance.py`.
- **C#** product: `MetaObjects/Provider.cs`, `MetaObjects/Registry.cs`, near `Loader/MetaDataLoader.cs` `DefaultRegistry`; runner `ProviderCompositionConformanceTests.cs`.
- **Java** product: `MetaDataRegistry.java`, `RegistryManifest.java`; runner `ProviderCompositionConformanceTest.java` (covers Kotlin).

## Manifest-shape extension (used by all tasks)

Add three OPTIONAL keys to the corpus manifest (existing error-code scenarios keep working unchanged):

```jsonc
{
  "description": "...",
  "providers": ["extend-spec-subtype"],   // named test providers, composed after core
  "composeWithCore": true,                  // NEW: compose the port's LIBRARY provider set first, then `providers`
  "expectAttrs": {                          // NEW (optional): registry-inspection assertion
    "type": "view", "subType": "currency", "contains": ["locale", "decimals"]
  },
  "metadata": { "metadata.root": { ... } }, // NEW (optional): a canonical-JSON doc to strict-load
  "expectErrors": ["ERR_UNKNOWN_ATTR"]      // NEW (optional): error codes the strict load must surface ([] = expect success)
}
```

Each runner: if `composeWithCore`, compose `[...libraryProviders, ...named]`; else today's named-only. If `expectAttrs`, assert `attrsOf(type,subType)` (resolving, effective) ⊇ `contains`. If `metadata`, strict-load it and assert the surfaced error codes equal `expectErrors` (order-insensitive; `[]` = zero errors).

The four fixtures:
1. `extend-spec-subtype-registry`: `composeWithCore`, `providers:["extend-spec-subtype"]`, `expectAttrs:{view,currency,contains:[locale,decimals]}`.
2. `extend-spec-subtype-strict-load`: + `metadata` = a doc with one `object.entity` field carrying `view.currency @decimals:2`, `expectErrors:[]`.
3. `extend-spec-subtype-typo-rejected`: same but `@decimalz:2`, `expectErrors:["ERR_UNKNOWN_ATTR"]`.
4. `misplaced-core-attr-consumer-registry`: `composeWithCore`, `providers:["extend-spec-subtype"]`, `metadata` = a doc with a `field.boolean` carrying `@maxLength:5`, `expectErrors:["ERR_UNKNOWN_ATTR"]`.

Canonical named provider **`extend-spec-subtype`**: id `"extend-spec-subtype"`, no deps; `registerTypes` calls the port's `extend("view","currency", <int attr "decimals">)`.

---

### Task 1: Shared fixtures + TS reference lane (all green)

**Files:** the 4 fixtures + README (create); TS runner (modify).
**Interfaces:** Produces the 4 fixtures + the `extend-spec-subtype` provider contract every port reuses.

- [ ] **Step 1: Write the 4 fixture JSONs** exactly per the shape above (real canonical-JSON `metadata` bodies — verify each loads as valid canonical JSON: `metadata.root` → `object.entity` with an `identity.primary`, a field carrying a `view.currency`/`field.boolean`).
- [ ] **Step 2: Extend `README.md`** with the success-scenario keys (`composeWithCore`, `expectAttrs`, `metadata`/`expectErrors`) + the `extend-spec-subtype` named-provider entry.
- [ ] **Step 3: Extend the TS runner** — add `extend-spec-subtype` (`registry.extend("view","currency",{...int attr decimals})`), and teach the runner the 3 new keys (compose-with-core via the port's `coreProviders`, `attrsOf` assertion, strict-load-and-collect-errors).
- [ ] **Step 4: Run TS** — `cd server/typescript && bun test packages/metadata/test/provider-composition-conformance.test.ts`. Expected: **all 4 green** (TS is the reference: extension survives, strict-load accepts `@decimals`, rejects `@decimalz` and misplaced `@maxLength`). If any fail, the fixture/runner is wrong — fix before proceeding (TS defines correct behavior).
- [ ] **Step 5: Commit** `test(#265): provider-composition success-scenario shape + 4 extend-subtype fixtures (TS reference green)`.

---

### Task 2: Python — RED baseline, then provenance fix

**Files:** runner `test_provider_composition_conformance.py` (modify); `provider.py`, `registry.py`, `spec_metamodel/__init__.py`, `core_types.py` (modify).

- [ ] **Step 1: Extend the Python runner** — add `extend-spec-subtype` + the 3 new keys (compose `core_providers()` + named when `composeWithCore`; `attrs_of`; strict-load via the loader collecting `.code`s).
- [ ] **Step 2: Run — RED baseline.** `cd server/python && uv run pytest tests/conformance/test_provider_composition_conformance.py -k extend -q`. Expected: fixtures 1,2,3 **FAIL** (prune deletes `decimals` → `attrsOf` lacks it / strict-load emits `ERR_UNKNOWN_ATTR`); fixture 4 passes. This is the confirmed #265 repro as a gated test.
- [ ] **Step 3: Stamp provenance at registration.** In `provider.py` compose loop (~77-81): set `registry._current_provider_id = p.id` (or pass through) around each `register_types`; clear after. In `registry.py` `register`/`extend` (~212-263): record `(type, subType, attr_name) -> current_provider_id` in a registry side-map; registrations with no current id default to a `LIBRARY` sentinel.
- [ ] **Step 4: Export the library-id set.** In `core_types.py` (~870-876) expose the frozen set of library provider ids (core/db/doc/prompt/ui) as e.g. `LIBRARY_PROVIDER_IDS`.
- [ ] **Step 5: Guard the prune.** In `_apply_strict_attr_scoping` (`spec_metamodel/__init__.py` ~565-597): the drop condition becomes `prunable AND name not in allow AND origin_of(type,subType,name) in LIBRARY_PROVIDER_IDS` (a consumer-origin or unknown-origin attr is never pruned).
- [ ] **Step 6: Run — GREEN.** Same command → fixtures 1,2,3,4 all pass. Then the full Python metadata suite + `registry-conformance` byte-match: `cd server/python && uv run pytest -q` (assert `registry-conformance` unchanged).
- [ ] **Step 7: Commit** `fix(#265): provenance-scoped strict attr prune (Python) — spare consumer extends`.

---

### Task 3: C# — RED baseline, then provenance fix (mirror Python)

**Files:** runner `ProviderCompositionConformanceTests.cs`; `Provider.cs`, `Registry.cs`, near `DefaultRegistry` (modify).

- [ ] **Step 1: Extend the C# runner** — `extend-spec-subtype` + the 3 keys (compose the 4 `DefaultRegistry` library providers + named; `AttrsOf`; strict-load via `MetaDataLoader.FromDirectory(dir, registry, strict:true)` collecting codes).
- [ ] **Step 2: Run — RED.** `cd server/csharp && dotnet test --filter ProviderComposition`. Expected: fixtures 1,2,3 FAIL (confirms C# shares the prune — Fable read-only, this is the live confirmation); 4 passes.
- [ ] **Step 3: Stamp provenance** — `Provider.cs::ComposeRegistry` (~50-69) sets a `CurrentProviderId` around each provider; `Registry.cs::Register`/`Extend` (~386-420) record `(type,subType,attr) -> id`; no-current defaults to LIBRARY.
- [ ] **Step 4: Library-id set** beside `Loader/MetaDataLoader.cs::DefaultRegistry` (~74-86).
- [ ] **Step 5: Guard the prune** — `Registry.cs::ApplyStrictAttrScoping` (~660-690) gains the `origin ∈ library` clause.
- [ ] **Step 6: Run — GREEN** + full C# suite + `registry-conformance` byte-match unchanged.
- [ ] **Step 7: Commit** `fix(#265): provenance-scoped strict attr prune (C#) — spare consumer extends`.

---

### Task 4: Java/Kotlin — close the consumer-path gap + provenance fix

**Files:** runner `ProviderCompositionConformanceTest.java`; `MetaDataRegistry.java`, `RegistryManifest.java` (modify).

- [ ] **Step 1: Extend the Java runner** — `extend-spec-subtype` + the 3 keys. Crucially, `composeWithCore` composes via the **sanctioned consumer seam** under test: `RegistryManifest.composeMetamodelRegistry(List.of(extendProvider))` (the new overload) — NOT raw `compose()` — so the runner exercises the path adopters use.
- [ ] **Step 2: Run — RED.** `cd server/java && mvn -q -pl metadata test -Dtest=ProviderCompositionConformanceTest`. Expected: fixture 4 (`misplaced-core-attr`) FAILS today because the consumer-path registry skips scoping (Java's second bug); fixtures 1–3 pass once the overload exists. (Before the overload exists this won't compile — so Step 3's overload is the minimal thing to get RED on #4.)
- [ ] **Step 3: Add `composeMetamodelRegistry(Collection<MetaDataTypeProvider> extra)`** to `RegistryManifest.java` (~114-129): compose `metamodelProviders() + extra` → force `getAllValidationConstraints()` → `applySpecDescriptions(...)` (provenance-safe after Step 4/5) → return (unsealed; caller may seal). Document it as the `MetaDataLoader.setTypeRegistry(...)` seam. Raw `MetaDataRegistry.compose(...)` unchanged.
- [ ] **Step 4: Stamp provenance** — `MetaDataRegistry.registerProviders` stamps `currentProviderId` around each `provider.registerTypes(this)`; `register`/`extendType` record `(type,subType,attr) -> id`; build-time enrichment (no current id) = LIBRARY.
- [ ] **Step 5: Guard the prune** — `applyStrictAttrScoping` (~979-1023): the drop clause on BOTH the direct and inherited requirement maps gains `&& isLibraryOrigin(id.type(), id.subType(), req.getName())`, where library-origin = stamped by a `metamodelProviders()` id (or unstamped/LIBRARY). `isPrunableAttr` unchanged.
- [ ] **Step 6: Run — GREEN** — `ProviderCompositionConformanceTest` all 4 green (Kotlin inherits). Then `mvn -q -pl metadata test` full + `registry-conformance` byte-match unchanged (the sealed default `composeMetamodelRegistry()` with no extras must emit the identical manifest).
- [ ] **Step 7: Commit** `fix(#265): provenance-scoped prune + composeMetamodelRegistry(extras) seam (Java/Kotlin)`.

---

### Task 5: Verify + docs + review + PR

- [ ] **Step 1: Cross-port green.** Run all four runners; confirm the 4 fixtures green in TS/Python/C#/Java(+Kotlin via the Java runner). Confirm `registry-conformance` manifest byte-match unchanged in every port.
- [ ] **Step 2: Correct the issue scope + docs.** Update `docs/features/extending-with-providers.md` if it needs a note that extend-under-strict is conformance-gated; note in the PR that #265 spans Python + C# (prune) and Java/Kotlin (consumer-path), and that the Java consumer-path weaker-strict bug is folded in (not filed separately). Document the accepted residual (misplaced-core-attr-*name* extend → `ERR_PROVIDER_ATTR_CONFLICT` on Py/C#/Java vs success on TS) in the design doc's non-goals (already there) + a one-line KNOWN_GAPS note if a per-port one exists.
- [ ] **Step 3: Per-unit review** — code-reviewer + code-simplifier on the diff; fix findings in place.
- [ ] **Step 4: no-mistakes gate** — rich `--intent` (the three-way divergence + provenance mechanism + the deliberate no-registry-conformance-change invariant); ensure `.serena/` + `.worktrees/` in `.git/info/exclude`.
- [ ] **Step 5: PR** — `Closes #265`; body: the three-way divergence table, the provenance fix, the Java consumer-path fold-in, the 4 conformance fixtures, the accepted residual, and that #267 unblocks on this. This is a **coordinated cross-port** change (PyPI + NuGet + Maven; npm is reference-only, no product change) — flag that the release is a coordinated patch when Doug cuts it.

## Self-Review

- **Spec coverage:** provenance stamp + guard (Python T2 / C# T3 / Java T4) ✓; Java consumer-path seam (T4) ✓; 4 conformance fixtures + shape (T1, exercised T2–T4) ✓; TS reference lane (T1) ✓; registry-conformance-unchanged invariant asserted per port (T2/T3/T4 step 6, T5 step 1) ✓; accepted residual documented (design + T5) ✓; batch note re #267 (T5) ✓.
- **Placeholders:** the per-port fix code is specified by mechanism + Fable's file:line map; exact lines are resolved via the RED→GREEN TDD loop in each task (write/observe the failing fixture first). C# mirrors Python deliberately.
- **Type consistency:** `extend-spec-subtype` provider contract + the manifest keys (`composeWithCore`/`expectAttrs`/`metadata`/`expectErrors`) are defined once (shape section) and consumed identically by all five runners; `composeMetamodelRegistry(extra)` (T4 S3) is consumed by the Java runner (T4 S1).
