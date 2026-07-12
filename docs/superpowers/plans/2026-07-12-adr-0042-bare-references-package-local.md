# ADR-0042 — Bare References Are Package-Local — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the ADR-0042 reference-resolution contract in all five ports (TS reference port first) — a bare reference resolves package-locally (referrer's package, else root), FQN resolves exactly on the resolution key, no unique-anywhere, no ambiguity — fixing #191, then cut a coordinated breaking cross-port release.

**Architecture:** The change is mostly *removal*. One resolution primitive (`resolveObjectRef`) collapses to a single resolution-key matcher; the bare-tail fallbacks and the referrer-package ambiguity pass are deleted; `@through` joins the desugar+ref set; `field.object`/`field.map` `@objectRef` gains a fail-closed dangling check (`ERR_UNRESOLVED_OBJECT_REF`); `ERR_AMBIGUOUS_REF` is retired. TS is the reference port; the other four mirror it, gated by the shared `fixtures/conformance` corpus.

**Tech Stack:** TS (`server/typescript/packages/metadata`), Python (`server/python`), Java (`server/java`), Kotlin (`server/java/.../codegen-kotlin` + metadata), C# (`server/csharp`). Cross-port gate: `fixtures/conformance/`.

## Global Constraints

- **Contract (ADR-0042 §Decision), identical in all five ports:**
  1. FQN ref (contains `::`) → EXACT match on `resolutionKey()`. Never a bare-tail fallback.
  2. Bare ref (no `::`) → package-local ONLY: an object whose resolution key is `<referrerPkg>::<name>` (referrer's own package), or `<name>` (root-level / empty-package). No cross-package bare resolution, no unique scan, no first-match.
  3. Every cross-package reference must be FQN. YAML desugar sugar unchanged (bare→`<currentPkg>::Name`; `pkg::Name` absolute; `::Name` root; `..::` parent-relative).
  4. Uniform across every ref-bearing attr: `@objectRef` (relationship, `field.object`, `field.map`), `@references`, `@from`/`@of`/`@via` heads, `@payloadRef`/`@responseRef`/`@parameterRef`, and **`@through`** (newly included). `extends` unchanged (its super-resolver is already same-package-then-root-strict).
  5. Unresolved ref = hard load error, per attr, with a did-you-mean hint listing same-short-name objects in other packages. Existing per-attr codes kept (`ERR_INVALID_RELATIONSHIP` / `ERR_INVALID_REFERENCE` / `ERR_INVALID_ORIGIN` / `ERR_INVALID_TEMPLATE` / `ERR_PARAMETER_REF_UNRESOLVED` / `ERR_UNRESOLVED_SUPER`); `field.object`/`field.map` `@objectRef` gains **`ERR_UNRESOLVED_OBJECT_REF`** (new).
  6. `ERR_AMBIGUOUS_REF` is RETIRED (unreachable once bare = package-local).
- **Metamodel string discipline:** named constants only (`packages/metadata/src/constants.ts` / per-port equivalent). New error code added to each port's error registry + `fixtures/conformance/ERROR-CODES.json`.
- **Conformance-gated:** every behavior change carries a fixture; all five ports err/serialize byte-identically.
- **TDD:** fixtures + failing tests first.
- **Breaking release:** coordinated across npm/PyPI/NuGet/Maven with an explicit BREAKING CHANGELOG banner. Pre-1.0 mandatory (freezing unique-anywhere into 1.0 would make the fragility permanent).

---

## Ground truth (verified 2026-07-12, TS)

- `server/typescript/packages/metadata/src/naming-refs.ts` — `resolveObjectRef` (unique-anywhere + `ambiguous`), `refMatchesObject` (`resolutionKey||fqn||name` — the `name===ref` is the bare-tail fallback), `REF_BEARING_ATTR_NAMES` (excludes `@through`), `expandRef` (desugar primitive — already package-local, correct, unchanged).
- `server/typescript/packages/metadata/src/core/yaml-desugar.ts:280-305` — expands `extends` + every `REF_BEARING_ATTR_NAMES` attr to FQN. Adding `@through` to the set auto-expands it (both `@through` and bare `through` paths).
- `server/typescript/packages/metadata/src/loader/validation-passes.ts:285-334` — `validateCrossPackageRefs` (the ambiguity pass — DELETE). `field.object` dangling `@objectRef` currently has NO check (only `ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF` for a missing ref). Relationship `@objectRef` dangling → `ERR_INVALID_RELATIONSHIP`; `identity.reference` → `ERR_INVALID_REFERENCE` (these are the models for the new field.object/map check). M:N `@through` junction validation lives here too (must match junction on FQN once `@through` is expanded).
- `resolutionKey()` = `<package|fileDefaultPackage>::<name>` (root-level object → bare `name`). `fqn()` for an object stays BARE (FR5d) — so FQN matching must use `resolutionKey()`, not `fqn()`.
- Error registry: `server/typescript/packages/metadata/src/errors.ts` + `fixtures/conformance/ERROR-CODES.json`.
- TS render/verify payload-tree already resolves FQN/same-package with no bare-tail fallback (0.15.14 / #182). Confirm no residual bare-tail fallback in codegen-ts nested-ref / payload-VO resolution.
- Existing fixtures: `error-xpkg-ambiguous-objectref` (relationship `@objectRef`, bare `Customer` from pkg `sales`, Customer only in vendor/crm → **re-expect `ERR_INVALID_RELATIONSHIP`**), `xpkg-collision-bare-same-package` (positive same-package guard — must stay green), `xpkg-*` FQN fixtures.

---

## Phase 1 — Conformance fixtures (the executable contract; write first)

Fixtures are JSON-input (canonical, NOT YAML — so they exercise the RESOLUTION layer's package-local bare handling directly, not just the desugar). Each has `input/*.json`, `providers.json`, `expected-errors.json` (or `expected-serialized.json` for positive).

### Task 1: Re-expect the retired ambiguity fixture
**Files:** Modify `fixtures/conformance/error-xpkg-ambiguous-objectref/expected-errors.json`
- [ ] Change `code` `ERR_AMBIGUOUS_REF` → `ERR_INVALID_RELATIONSHIP` (bare `Customer` on `sales::Order` now folds package-local to `sales::Customer`, which dangles). Keep `source` (referrer `Order`, target `Customer`). Consider renaming the dir to `error-xpkg-bare-dangling-objectref` for accuracy, or leave the name and note the semantic shift in a `README`/`notes`.
- [ ] Verify against ADR did-you-mean phrasing (hint names `vendor::Customer`, `crm::Customer`).

### Task 2: New — bare unique-elsewhere now errors
**Files:** Create `fixtures/conformance/error-xpkg-bare-unique-elsewhere/{input,expected-errors,providers}`
- [ ] Object `app::a::Payload` with a `field.object thing objectRef: Thing`; a single `app::b::Thing` (unique, in ANOTHER package). Under ADR-0041 this resolved (unique-anywhere); under ADR-0042 bare folds to `app::a::Thing` which dangles → `ERR_UNRESOLVED_OBJECT_REF` with a did-you-mean naming `app::b::Thing`.

### Task 3: New — dangling field.object + field.map @objectRef
**Files:** Create `fixtures/conformance/error-field-objectref-unresolved/…` and `error-field-map-objectref-unresolved/…`
- [ ] `field.object` with `@objectRef` to a nonexistent object (same package) → `ERR_UNRESOLVED_OBJECT_REF`.
- [ ] `field.map` with `@objectRef` to a nonexistent object → `ERR_UNRESOLVED_OBJECT_REF`.

### Task 4: New — @through FQN positive + bare cross-package negative
**Files:** Create `fixtures/conformance/xpkg-through-fqn/…` (positive, `expected-serialized.json`) and `error-xpkg-through-bare/…` (negative)
- [ ] `xpkg-through-fqn`: an M:N relationship whose `@through` is a FQN to a junction in another package resolves + serializes.
- [ ] `error-xpkg-through-bare`: an M:N relationship whose `@through` is a bare name of a junction in another package → dangles package-local → `ERR_INVALID_RELATIONSHIP` (M:N junction-missing).

### Task 5: Positive load-order-independent bare-same-package guard
**Files:** Confirm/extend `fixtures/conformance/xpkg-collision-bare-same-package`
- [ ] Ensure it proves a bare ref binds the referrer's-own-package object regardless of file load order (two same-named objects in different packages; the referrer's package one wins; the other is never bound).

---

## Phase 2 — TS reference port

### Task 6: `resolveObjectRef` + `refMatchesObject` → package-local
**Files:** Modify `server/typescript/packages/metadata/src/naming-refs.ts`
- [ ] `resolveObjectRef`: FQN → `objects.find(c => c.resolutionKey() === ref)`. Bare → `objects.find(c => c.resolutionKey() === localKey || c.resolutionKey() === ref)` where `localKey = referrerPkg ? `${referrerPkg}::${ref}` : ref`. Return `{ node }` only — DROP the `ambiguous` field.
- [ ] `refMatchesObject`: `return node.resolutionKey() === ref;` — drop `|| node.fqn() === ref || node.name === ref`.
- [ ] Add `RELATIONSHIP_ATTR_THROUGH` to `REF_BEARING_ATTR_NAMES`; update the doc-comment (remove "@through intentionally NOT in this set").
- [ ] Delete `objectPackage` if now unused; keep otherwise.
- [ ] TDD: unit tests in `naming-refs.test.ts` — bare same-package resolves, bare unique-elsewhere returns `{}` (unresolved), FQN exact, FQN to wrong package returns `{}`.

### Task 7: Retire the ambiguity pass; add fail-closed field.object/map dangling check + did-you-mean
**Files:** Modify `server/typescript/packages/metadata/src/loader/validation-passes.ts`, `validation-registry.ts`
- [ ] DELETE `validateCrossPackageRefs` + its registration + import; remove `ERR_AMBIGUOUS_REF` usage.
- [ ] Add `validateFieldObjectRefResolves` (mirrors relationship/identity dangling checks): for every `field.object`/`field.map` with an `@objectRef` that does not resolve (`resolveObjectRef(...).node === undefined`), emit `ERR_UNRESOLVED_OBJECT_REF` with a did-you-mean hint (`objectsNamed(shortName).map(resolutionKey)`). Register it.
- [ ] Add a shared `didYouMeanHint(root, ref)` helper (short-name scan across other packages) and thread it into the unresolved messages for relationship `@objectRef`, identity `@references`, origin heads, template refs, `@parameterRef`, and the new field.object/map check.
- [ ] Ensure `@through` (now FQN-expanded) resolves the junction via `resolveObjectRef`/`refMatchesObject` (FQN-exact); a bare/dangling `@through` → the existing M:N junction error.

### Task 8: Error registry + constants
**Files:** Modify `server/typescript/packages/metadata/src/errors.ts`, `constants.ts`, `fixtures/conformance/ERROR-CODES.json`
- [ ] Remove `ERR_AMBIGUOUS_REF`; add `ERR_UNRESOLVED_OBJECT_REF` (description: "A `field.object`/`field.map` `@objectRef` (bare→package-local, or FQN) resolves to no object in the loaded tree.").
- [ ] Update `ERR_INVALID_RELATIONSHIP` / `ERR_INVALID_REFERENCE` descriptions to note `@through` is now FQN-in-the-ref-set and ambiguity is retired.

### Task 9: Codegen/runtime bare-tail residue sweep (TS)
**Files:** grep `server/typescript/packages/codegen-ts/src`, `runtime-ts`, `migrate-ts`
- [ ] Confirm no remaining bare-tail fallback in nested-ref / payload-VO / binding-site resolution (0.15.14 removed the render/verify one; verify none elsewhere). Where a resolver still short-name-matches a ref, switch it to `resolveObjectRef`/`refMatchesObject`.

### Task 10: Regen goldens + green the server suite
- [ ] `cd server/typescript && bun test` — fix golden/accessor updates (ADR predicts ~25 of 2125). Regen any snapshot fixtures.
- [ ] `bun run --filter '*' typecheck && bun run --filter '*' build`.
- [ ] Run `/code-review` + `/simplify` on the TS diff; fix findings.
- [ ] Commit to `main` (forward-only).

---

## Phase 3 — Port to Python / Java / Kotlin / C# (parallelizable; each gated by the shared corpus)

Each port task (dispatch as a subagent per port; use the **cross-language-porting** skill) applies the SAME contract:
- Resolution primitive → package-local FQN/resolution-key matcher; delete unique-anywhere + bare-tail fallback (#191 named the Python `payload_vo_generator._resolve_object_field_type` rsplit fallback + `render_helper_generator._resolve_nested_object_ref`).
- Retire `ERR_AMBIGUOUS_REF`; add `ERR_UNRESOLVED_OBJECT_REF` fail-closed check for `field.object`/`field.map`.
- Add `@through` to the ref/desugar set; junction resolves FQN-exact.
- did-you-mean hints.
- Run that port's conformance corpus green (all Phase-1 fixtures) + registry-conformance (error-code manifest).
- **C# gotcha (memory):** C# has a COMMITTED `SpecMetamodel/*.json` copy to sync (like Python); Java auto-refreshes. Sync it or conformance silently fails.

### Task 11: Python port  ### Task 12: Java port  ### Task 13: Kotlin port  ### Task 14: C# port
(Each: TDD against the shared corpus; run `scripts/ci-local.sh --only <port>`; review+simplify; commit forward.)

### Task 15: Cross-port conformance green
- [ ] All five ports run `fixtures/conformance` + `fixtures/registry-conformance` byte-identical. `ERROR-CODES.json` matches every port's registry.

---

## Phase 4 — Coordinated breaking release

### Task 16: Release (use the **releasing** skill; Claude runs all four registries)
- [ ] CHANGELOG: BREAKING banner (unique-anywhere removed; bare packaged cross-package ref in hand-written canonical JSON changes meaning; `ERR_AMBIGUOUS_REF` retired; new `ERR_UNRESOLVED_OBJECT_REF`; `@through` FQN). No port-portable YAML-authored model changes meaning.
- [ ] Version bump on the current line (npm/PyPI/NuGet/Maven), lockstep per RELEASING.md; regen lockfile; `bun publish`.
- [ ] Propagate version markers/docs; close #191 with the shipped fix; reopen if it was closed prematurely and re-close on release.

---

## Self-review checklist
- [ ] Spec coverage: every ADR-0042 §Decision item (1-6) + §Consequences fixture list mapped to a task above. ✅
- [ ] No placeholders in the TS (contract-defining) tasks; port tasks are declarative-by-design (they mirror TS + the shared corpus is the exact spec).
- [ ] Type consistency: `resolveObjectRef` returns `{ node? }` (no `ambiguous`) everywhere after Task 6; all callers updated (grep `.ambiguous`).
