# SP-G Registry Conformance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`.

**Goal:** Each port emits its metamodel-registry as a canonical normalized manifest; assert all 5 byte-identical to a single-source `fixtures/registry-conformance/expected-registry.json`. Catch the SP-C class of silent vocabulary drift structurally. Plus an untested-vocabulary coverage report.

**Architecture:** Byte-identical-to-committed-canonical (like render/output-prompt conformance). TS is the reference. Manifest = LOGICAL vocabulary only (type.subType + attrs[name,valueType,required] + childRules + commonAttrs + defaultSubTypes); physical bindings/factories/native-types EXCLUDED. Building it will surface real divergences → fix at source.

**Tech stack:** per-port registry walk → canonical JSON; runners in each port's conformance test layer. Design: `docs/superpowers/specs/2026-06-02-sp-g-registry-conformance-design.md`.

**Worktree:** `<repo-root>/.claude/worktrees/sp-g-registry-conformance` (branch `sp-g-registry-conformance`, off origin/main).

---

### Unit 1: Manifest schema + TS reference emitter + canonical (the crux)

**Files:**
- Create: `server/typescript/packages/metadata/src/registry-manifest.ts` (walk TypeRegistry → canonical manifest)
- Create: `fixtures/registry-conformance/expected-registry.json` (single-source canonical, generated from TS)
- Create: `fixtures/registry-conformance/README.md`
- Create: a TS conformance test asserting emitted == committed canonical (in `packages/metadata/test/`)

- [ ] **Step 1 — Resolve the in/out boundary.** Inspect all 5 ports' AttrSchema/TypeDefinition to decide the three open calls from the spec: (a) `allowed_values`/`default` on attr schemas — include only if ALL ports track them on the schema; (b) `inheritsFrom` — include only if all ports expose the declared parent; (c) `childRules` representation — normalize to `{childType, childSubType}` or defer if Java's globalRequirements can't map cleanly. Pick the LARGEST subset emittable identically by all 5; document exclusions in the README. When unsure, exclude + note (smaller airtight > bigger flaky).
- [ ] **Step 2 — TS emitter.** `emitRegistryManifest(registry): string` — walk the TS `TypeRegistry` (the assembled core-types registry), produce the manifest per the schema, FULLY SORTED (types by `type.subType`, attrs by name, childRules by `childType.childSubType`, defaultSubTypes keys sorted), stable JSON (2-space, trailing newline — match the repo's canonical-JSON style). `valueType: null` for polymorphic attrs.
- [ ] **Step 3 — Generate the canonical.** Run the emitter against the real core registry, write `fixtures/registry-conformance/expected-registry.json`. Eyeball it: every field subtype, validator subtype (length/regex/numeric/array w/ @min/@max/@pattern — the SP-C vocab), object/source/origin/identity/relationship/layout/template subtypes, commonAttrs (description/title/notes/deprecated/...), defaultSubTypes.
- [ ] **Step 4 — TS conformance test.** Assert `emitRegistryManifest(coreRegistry) === read(expected-registry.json)`. On mismatch, message: "TS registry drifted from the committed manifest — regenerate (and reconcile the other ports) or fix the registration." Run green.
- [ ] **Step 5 — README + commit.** README documents the in/out boundary + the fix-at-source-on-divergence rule. Commit: `feat(conformance): SP-G Unit 1 — registry manifest schema + TS reference emitter + canonical`

### Unit 2: C# emitter + reconcile to canonical

**Files:** `server/csharp/MetaObjects.Conformance.Tests/` (or where conformance tests live) — a C# emitter walking the C# registry + a test asserting == `expected-registry.json`.

- [ ] **Step 1 — C# emitter.** Walk the C# type registry → the SAME canonical manifest (same field set, same sort, same JSON formatting as TS — match byte-for-byte). Use the metamodel constants, not literals.
- [ ] **Step 2 — Assert == canonical.** Test compares the emitted manifest to the committed `expected-registry.json` (byte-identical, newline-normalized).
- [ ] **Step 3 — Reconcile divergences.** Any mismatch = a real C# registry divergence. Fix the C# REGISTRATION to match the cross-port contract (only change the canonical if TS is the one wrong — escalate that). Report every divergence found + fixed.
- [ ] **Step 4 — Verify + commit.** `cd server/csharp && dotnet test MetaObjects.Conformance.Tests/...` green. Commit: `feat(conformance): SP-G Unit 2 — C# registry manifest emitter + reconcile to canonical`

### Unit 3: Java (+ Kotlin) emitter + reconcile

**Files:** `server/java/metadata/src/test/.../` (Java emitter walking `MetaDataRegistry`) + a Kotlin runner (Kotlin shares the JVM registry).

- [ ] **Step 1 — Java emitter.** Walk `MetaDataRegistry` (typeDefinitions + commonAttributes + defaultSubTypes + child requirements) → the canonical manifest, byte-matching TS's format.
- [ ] **Step 2 — Assert == canonical** (a metadata-module test). Kotlin: a runner in `codegen-kotlin`/`integration-tests-kotlin` asserting the SAME manifest from the JVM registry (proves Kotlin's view matches; likely identical since it reuses the Java registry).
- [ ] **Step 3 — Reconcile.** Fix Java registry divergences at source (SP-C already fixed the validator attrs; surface anything else). Report.
- [ ] **Step 4 — Verify + commit.** `cd server/java && mvn -q -pl metadata test -Dtest=<RegistryManifestTest>` (+ the Kotlin runner) green. Commit: `feat(conformance): SP-G Unit 3 — Java/Kotlin registry manifest emitter + reconcile`

### Unit 4: Python emitter + reconcile

**Files:** `server/python/tests/conformance/` — Python emitter walking `TypeRegistry` + a test asserting == canonical.

- [ ] **Step 1 — Python emitter.** Walk `TypeRegistry._defs` + `_common_attrs` + `_default_sub_types` → the canonical manifest, byte-matching.
- [ ] **Step 2 — Assert == canonical.** pytest comparing emitted == committed.
- [ ] **Step 3 — Reconcile.** Fix Python registry divergences at source (SP-C fixed the missing validator subtypes; surface anything else). Report.
- [ ] **Step 4 — Verify + commit.** `cd server/python && uv run --extra dev pytest tests/conformance/<test_registry_manifest>.py -q` green. Commit: `feat(conformance): SP-G Unit 4 — Python registry manifest emitter + reconcile`

### Unit 5: Untested-vocabulary coverage report

**Files:** a check (TS, since the conformance corpora are easiest to scan from there, or wherever practical) that cross-references the registry against the fixture corpora.

- [ ] **Step 1 — Build the coverage scan.** For each registered `(type, subType)` (and optionally each attr), determine whether ANY conformance fixture (`fixtures/conformance/`, render/persistence/api-contract/etc.) references it. Emit a report of the unexercised vocabulary.
- [ ] **Step 2 — Decide fail-vs-warn (ask the user if non-trivial).** If the untested set is small/empty → hard-fail (gate). If it's a real backlog → emit as a warning/report so it's VISIBLE (not invisible), and capture the list. Default to a report that surfaces the gap; only hard-fail if the user wants it.
- [ ] **Step 3 — Commit.** `feat(conformance): SP-G Unit 5 — untested-vocabulary coverage report`

### Unit 6: Lock canonical + CI + sweep + finish

- [ ] **Step 1 — Confirm all 5 agree.** Re-run all 5 emitters → all byte-identical to `expected-registry.json`. If reconciliation changed the canonical, re-verify every port.
- [ ] **Step 2 — CI.** Wire the 5 registry-manifest runners into `conformance.yml` (TS/C#/Java/Python under the `conformance` matrix; Kotlin under `conformance-kotlin`) — no Docker. Confirm picked up.
- [ ] **Step 3 — Docs.** README final; CLAUDE.md cross-language-porting section points at the registry-conformance gate as the structural enforcer of "vocabularies identical across languages."
- [ ] **Step 4 — Review + finish.** Simplifier + final reviewer over the whole SP-G diff (focus: the manifest is byte-identical across ports; the in/out boundary is principled [no physical bindings leaking in]; divergence fixes are at-source + correct; no port silently excluded). Merge forward (integrate-before-merge — main is active).

## Self-review notes
- The byte-identical format must be IDENTICAL across the 5 emitters (same field order via sorting, same JSON spacing, same null-rendering for polymorphic valueType). Define the exact serialization in Unit 1 + each port matches it.
- Expect Unit 2/3/4 to FIND divergences — that's success, not failure. Fix at source; report each.
- If a facet can't be emitted identically by all 5, EXCLUDE it from v1 + document — never per-port-conditional.
- TS is the reference for the canonical, but if a divergence reveals TS itself is wrong vs the documented contract, fix TS + regenerate the canonical (escalate/note).
