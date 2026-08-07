# Plan: projection/payload vocabulary batch — #270 → doctrine docs → `@role` shrink (+#212) → #210

**Date:** 2026-08-06 · **Baseline:** `main` @ `2caa9684` (clean; `0.20.15` / `7.20.15` shipped to all four registries)
**Executes from:** this file alone. The authoring session's context is gone — every premise below must be **re-derived from code** before acting on it (see "Meta-lesson").
**Authoritative rulings:** `spec/roadmap.md` — the `#210 — [RULED 2026-08-05 …]` block (~L135) and the `#212 — [RULED 2026-08-05 …]` block (~L137). Issues: #270 (re-scoped), #210, #212, #271. **Do not re-litigate the rulings; sequence and implement them.**

---

## STATUS — update as you go (edit this file, commit the checkbox flips with the work)

- [ ] Phase 0 — setup, premise recon
- [ ] Unit A (#270) — Python: payload typing declared-authoritative
- [ ] Unit A (#270) — Kotlin: payload typing declared-authoritative
- [ ] Unit A (#270) — docs closure (CLAUDE.md open question, KNOWN_GAPS, roadmap)
- [ ] Unit A — independent review + merge to `main` + local-ci green
- [ ] Release 1 — `0.20.16` / `7.20.16` coordinated PATCH (checkpoint with the maintainer first)
- [ ] Unit B — doctrine docs amendment (ADR-0007 / FR-024 §7) — docs-only
- [x] Unit C — Gate 0 adopter scan — **CLEARED 2026-08-06** (see C.0)
- [ ] Unit C — `@role` shrink to `primary | replica` (+ close #212)
- [ ] Unit D — #210: assembly origins off `object.value`; `@payloadRef`/`@responseRef` widened — **blocked on Unit A + #271 disposition**
- [ ] Fixture-count + docs propagation (262 → recounted)
- [ ] Batch (Units C+D) — independent review + merge to `main` + local-ci green
- [ ] Release 2 — `0.21.0` / `7.21.0` coordinated MINOR (breaking-for-authors, ADR-0035 §3 window)
- [ ] Issues closed with receipts: #270, #212, #210 (+ #271 disposition recorded)

---

## Meta-lesson (read before every unit)

Two issues filed 2026-08-05 (#270, #271) both had their premises **falsified by recon within hours** — #270 was re-scoped as a result, and #271 turned out to be mostly already-correct. Therefore:

1. **Every unit below opens with a "Premise recon" step. Run it.** The file/line anchors here were verified at `2caa9684`; `main` may have moved.
2. If a premise does not hold (a file is gone, a behavior is already fixed, a "correct" port turns out to also be affected, an anchor doesn't match), **STOP that unit and report to the maintainer** with what you found. Do not force the plan through a falsified premise, and do not silently widen scope.
3. Before implementing against any issue: `git log --grep '#210\|#212\|#270' --oneline` and grep the target code — part of the work may already have landed.

---

## House rules (binding)

- **Git:** `main` is forward-only (merge/FF only, never rebase/reset/force). Stage **explicit paths** — never `git add -A`. Author `Doug Mealing <doug@dougmealing.com>`.
- **Review:** independent review before anything merges. The `no-mistakes` gate cannot validate work already on `main` — do each unit on a **short-lived branch**, run the gate there, then merge (no rebase). If work lands on `main` first, use a **report-only reviewer agent over the commit range** — never a replay branch. `.serena/` must be in `.git/info/exclude` or the gate refuses to start.
- **TDD:** failing test first, then implementation.
- **Fix in place:** any bug found mid-flight is fixed in this batch — never `gh issue create` a follow-up unless asked.
- **Public repo hygiene:** no private project names, no home-directory paths, in any committed file or commit message. Pre-commit guard enforces a denylist — genericize; never `--no-verify`.
- **CI:** PRs get leak-scan only. Non-TS suites run on push to `main` via self-hosted `local-ci.yml` (affected ports). After each push: `gh run list --workflow local-ci.yml --limit 3` then `gh run watch <id>`. The pre-push hook reads the **working tree** — keep it clean at push time.
- **Releases:** `bun publish` never `npm publish`; Maven deploy never `-o`, and >10 min is **not** a failure (verify via the Central Portal, never re-run); verify npm via `npm dist-tag ls`, not log greps. `npm dist-tag rm … next` 403s on this account — harmless, don't chase. Pushing a `csharp-v*` tag already triggers the NuGet workflow — don't also `gh workflow run` it. See `docs/RELEASING.md`.
- **Never run a bare `bun test` at the repo root.** Scope to `server/typescript` or a single package.

---

## Sequencing and release shape (decided — do not re-open)

**Dependency chain:** #210 is blocked on #270 (the payload tier must be declared-authoritative before values lose assembly origins) **and on #271's disposition** (the roadmap ruling names both preludes — see Unit D gate 0). #212 is **subsumed** by the `@role` shrink (its actionable registry content is exactly "remove `publish`"; its doctrinal content is Unit B). Doctrine docs (Unit B) land before the registry change they describe (Unit C). Within the breaking batch the **`@role` shrink goes first**: smallest possible registry diff, exercises the full five-port regen/sync pipeline in isolation (a dry run for #210's rules-string change), and its only external dependency (the adopter scan) is already cleared.

**Exactly two releases:**

| Release | Version | Contents | Product code | Why |
|---|---|---|---|---|
| **Release 1** | npm/PyPI/NuGet `0.20.16` · Maven `7.20.16` — coordinated PATCH | Unit A (#270) | Maven (`codegen-kotlin`) + PyPI; npm + NuGet are version-parity bumps per the one-shared-patch policy (in force since `0.20.13`) | #270 is a live silent-wrong-output bug. It must not wait on the breaking batch. |
| **Release 2** | npm/PyPI/NuGet `0.21.0` · Maven `7.21.0` — coordinated MINOR, **breaking-for-authors** | Units B + C (closes #212) + D (#210) | All five ports | Registered-vocabulary removals + a registry `rules`-string change = author-facing breaks ⇒ MINOR per `docs/RELEASING.md`. This **is** the ADR-0035 §3 consolidation batch #210 requires. |

**Checkpoint:** at Release 1 time, ask the maintainer whether to cut immediately or let #270 ride `0.21.0` (default: cut it). Record the answer here.

---

## Phase 0 — setup and premise recon

```bash
cd <repo-root>
git fetch origin && git log --oneline -3 origin/main   # at/after 2caa9684; local main is routinely stale — origin/main is ground truth
git status --short                                      # must be clean
git config core.hooksPath                               # expect .githooks
ls -d fixtures/conformance/*/ | wc -l                   # expect 262
```

Read the rulings in `spec/roadmap.md` (grep `"#210 — \[RULED"`, `"#212 — \[RULED"`), and `gh issue view 270 210 212 271`.

---

## Unit A — #270: payload typing is declared-type-authoritative (Kotlin + Python)

**Ruling:** TS / C# / Java payload emitters are origin-blind and **correct**. Kotlin and Python derive payload field types from `origin.*`; on `origin.collection` they discard the field's declared `@objectRef` and substitute the `@via` relationship's target entity — a declared curated VO silently becomes the full entity, defeating the payload-bloat contract. `@agg count` is hardwired to a long type regardless of a declared `field.int`. Delete the origin dispatch **including** the `origin.collection` edge in each port's ADR-0044 name-map closure and the extract tier that shares the name map (#228) — lockstep per port. Nullability falls back to declared `@required`.

### A.0 Premise recon (stop if any fails)

```bash
grep -n "origin" server/typescript/packages/codegen-ts/src/payload-codegen.ts            # expect: no type dispatch on origin.*
grep -rn "Origin" server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringPayloadGenerator.java   # expect: none
grep -rniE "origin" server/csharp/MetaObjects.Render server/csharp/MetaObjects.Codegen --include='*.cs' -l               # any hits must NOT drive payload field TYPES
grep -n "resolveCollectionType\|resolveAggregateType\|resolvePassthroughType\|resolveFirstType" server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinPayloadGenerator.kt
grep -n "_resolve_collection_type\|_resolve_aggregate_type\|_resolve_passthrough_type\|_find_origin_child" server/python/src/metaobjects/codegen/generators/payload_vo_generator.py
```

If TS/C#/Java are **not** origin-blind, or Kotlin/Python are already fixed → **STOP, report.**

### A.1 Files (anchors verified @ `2caa9684`)

**Kotlin** (`server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/`):
- `KotlinPayloadGenerator.kt` (431 lines) — origin dispatch in `resolveFieldType` (~L163–230: `PassthroughOrigin`/`AggregateOrigin`/`CollectionOrigin`/`ComputedOrigin`/`FirstOrigin`); `resolvePassthroughType` ~L286; `resolveAggregateType` ~L303 (count→`Long` ~L315); `resolveFirstType` ~L341; `resolveCollectionType` L363–403 (the declared-`@objectRef`-discarding walk). Class KDoc L41–53 documents the origin-aware contract — rewrite it.
- `KotlinGenUtil.kt` — ADR-0044 closure: `collectNestedClosure` ~L367, `nestedTargetOf` ~L394–405 (the `CollectionOrigin` branch derives the target from `@via`; the `@objectRef` branch ~L410 already filters to `SUBTYPE_VALUE` — **that branch stays**).
- Extract tier sharing the map (#228): `KotlinExtractorGenerator.kt`, `KotlinExtractMapperEmitter.kt`, `KotlinOutputParserGenerator.kt` — no origin code of their own; they change only if their fixtures reach nested VOs via `origin.collection`.

**Python** (`server/python/src/metaobjects/codegen/`):
- `generators/payload_vo_generator.py` (857 lines) — `_find_origin_child` L313, `_resolve_passthrough_type` L339, `_resolve_aggregate_type` L355, `_resolve_collection_type` L380, dispatch in `_resolve_field_type` L432–478, `_nested_target_of` L499 (the `origin.collection` closure edge), `_collect_nested_closure` L538. Module docstring L13–25 — rewrite. Delete now-unused imports (`MetaOrigin`, `ORIGIN_ATTR_*`) — no orphans.
- `collision_names.py` — shared ADR-0044 naming pass; origin-free, consistent once the closure shrinks.
- Extract tier: `generators/extractor_generator.py`, `generators/output_parser_generator.py` — import the closure/resolver from `payload_vo_generator`; no own origin code.

**Behavior after (both ports, identical):** a payload field's type comes **only** from declared `field.<subType>` + `@isArray` + `@objectRef`; nullability **only** from declared `@required`. The nested-payload closure edge is **only** a declared `field.object @objectRef` (target must be an `object.value` — existing rule). A field carrying any `origin.*` types exactly as if the origin were absent. A non-object field with `origin.collection` contributes **no** nested class.

**Docs closure (same unit):**
- `CLAUDE.md` Open questions (~L555): delete `[TECHNICAL] Payload origin.* resolution in codegen-spring …` — MOOT. Verify first: `grep -n "payload" server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md` (the entry it cites no longer exists; if a remnant does, delete it in place).
- `server/java/codegen-kotlin/.../KNOWN_GAPS.md` — grep for payload-origin entries.
- `spec/roadmap.md` — mark #270 shipped.

### A.2 TDD order

1. **Python RED:** `server/python/tests/codegen/test_payload_vo_generator.py` — the test ~L290–316 (`origin.collection` on a declared `field.string` asserted as `list[PostPayload]`) **encodes the pathology**; flip it to assert the declared type (`posts: str`, no `PostPayload` emitted). Flip `test_origin_collection_nested_payload_self_contained_per_file` and every other origin-typing assertion. **Add the disagreement test:** declared `field.object @objectRef: <CuratedVO> @isArray` + `origin.collection @via` pointing at a **different** full entity → asserts `list[<CuratedVO>Payload]` (DECLARED wins) and that the closure emits the curated VO's class, not the entity's.
2. **Python GREEN:** implement.
3. **Kotlin RED:** update `KotlinPayloadGeneratorTest.kt` / `KotlinGenUtilTest.kt`; add the mirrored disagreement test.
4. **Kotlin GREEN:** implement.
5. **Extract tier:** run `KotlinExtractTierCollisionTest`, `test_extract_tier_collision.py`. If their fixtures reach the colliding VO via `origin.collection`, re-author to reach it via declared `field.object @objectRef` — meaning preserved (still a cross-package short-name collision through the closure).

### A.3 Gates (verbatim)

```bash
cd server/python && uv run pytest tests/codegen/test_payload_vo_generator.py tests/codegen/test_extract_tier_collision.py tests/codegen/test_extractor_generator.py tests/codegen/test_output_parser_generator.py tests/codegen/test_fr010_output_codegen.py -q
cd server/python && uv run pytest -q
cd server/java && mvn -pl codegen-kotlin -am -Dtest='KotlinPayloadGeneratorTest,KotlinGenUtilTest,KotlinExtractTierCollisionTest,KotlinCodegenSnapshotTest,KotlinOutputParserGeneratorTest' -Dsurefire.failIfNoSpecifiedTests=false test
cd server/java && mvn -pl codegen-kotlin -am test        # full module; never -T on java
```

### A.4 Byte-identical requirements

- `server/java/codegen-kotlin/src/test/resources/snapshots/payload-with-origins/**` must be **byte-identical** — its fixture (`AuthorReport`: `name` = declared string + passthrough-from-string; `postCount` = declared long + `@agg count`) has declared == derived everywhere. **This snapshot IS the declared==derived gate.** If it changes, either the fixture secretly encodes the bug (justify line-by-line) or the change is wrong.
- All other Kotlin snapshots unchanged.
- Zero product-file changes outside `server/java/codegen-kotlin/` and `server/python/` (+ the three doc files): prove with `git diff --stat main...`.
- Shared corpora unaffected — verified: no `origin.collection`/`origin.aggregate` in `fixtures/template-codegen-conformance/`, `fixtures/extract-conformance/`, `fixtures/render-conformance/`.

### A.5 Stop-and-escalate

A "correct" port dispatches on origins (A.0) · the `payload-with-origins` snapshot changes (A.4) · the extract-tier collision tests can't preserve meaning without `origin.collection` edges (the #228 name-map contract would depend on via-derived targets — unanticipated) · any generated-API-shape doubt → check the integration compile gate, not just string asserts (ADR-0045 lesson).

### A.6 Merge + close

Branch `fix/270-declared-type-authoritative-payloads` → `no-mistakes` gate → merge to `main` → push → watch `local-ci.yml` (affected: java, python). Close #270 with a receipt (SHA + flipped-test path + snapshot-unchanged proof).

---

## Release 1 — `0.20.16` / `7.20.16` (coordinated PATCH)

**Checkpoint the maintainer first.**

1. `CHANGELOG.md` `[0.20.16]`: #270 — Kotlin + Python payload/extract tier is declared-type-authoritative; a declared curated VO no longer silently becomes the `@via` entity; `@agg count` no longer overrides a declared subtype; npm + NuGet are version-parity bumps.
2. Follow `docs/RELEASING.md` + the `releasing` skill. PyPI token: `awk 'NR==4{print $2}' ~/Work/Keys/pypi.txt`. The two integration-test poms sit outside the reactor — `versions:set` misses them; use grep/sed then `scripts/check-pom-versions.sh`.
3. Post-release docs-propagation commit (pattern: `2caa9684`): `CLAUDE.md` status, `README.md`, `docs/llms/llms{,-full}.txt`, `spec/roadmap.md`, port docs, + the site mirror.

---

## Unit B — doctrine docs amendment (docs-only)

Per the #212 ruling: the ADR-0007/0028/FR-024 doc amendment lands **now** — ADR-0035 §1 excludes reserved-but-unregistered from the compat surface, so no quiet-clock reset.

> **NOTE (2026-08-06):** the ADR-0007 Amendments 1–2 and the ADR-0028 amendment **already landed** (commits `91de3a85`, `d6e250f3`). Verify with `grep -n "addressable state at rest" spec/decisions/ADR-0007*.md` and `grep -n "Amendment (2026-08-06)" spec/decisions/ADR-0028*.md`. If present, this unit reduces to: confirm FR-024 §7's channel row references a **projection** (already done in `91de3a85`) and mark the roadmap line. **Re-verify before doing anything.**

---

## Unit C — `@role` shrink to `primary | replica` (subsumes #212)

**Ruling:** shrink `source.rdb @role` `allowedValues` to `primary | replica`; `index`/`cache`/`publish`/`mirror` become **reserved-not-registered** (ADR-0040 treatment). Every read of `@role` in all five ports is an equality test against `primary`, so no behavior dispatch exists to break. Constants are **deleted**, not orphaned.

### C.0 Gate 0 — adopter scan: **CLEARED 2026-08-06**

Scanned this repo, the public reference app, and the maintainer's downstream consumer models on the workstation. **Result: zero uses of `index`/`cache`/`publish`/`mirror`.** The only `source.rdb @role` values authored anywhere are `primary` and `replica` (a downstream consumer uses both on a write-through table+view pair); the public reference app authors no `@role` at all. **The shrink is safe.** Re-run before landing only if significant time passes:

```bash
grep -rnE '"role"[[:space:]]*:[[:space:]]*"(index|cache|publish|mirror)"|role:[[:space:]]*(index|cache|publish|mirror)' metaobjects/ examples/ fixtures/ --include='*.json' --include='*.yaml' --include='*.yml'
```

…plus the same grep over the `metaobjects/` tree of the public reference app and any downstream consumer the maintainer names (**never name private consumers in this repo** — record results generically). Any hit → **STOP, report.**

### C.1 Premise recon

```bash
grep -n '"role"' spec/metamodel/db.json                       # L44: six members + a description enumerating all six
grep -n 'publish' fixtures/registry-conformance/expected-registry.json | head -3   # ~L3746
git log --oneline --grep 'role' -10
```

### C.2 Registry-change pipeline (this exact order)

1. Edit `spec/metamodel/db.json` L44: `allowedValues` → `["primary", "replica"]`; rewrite the description (it byte-propagates everywhere): name the two members, state the other four are reserved-not-registered (ADR-0007 amendment). **Pick the wording once — it must be byte-identical in every copy below.**
2. `bun run scripts/generate-embedded-metamodel.ts` → regenerates `server/typescript/packages/metadata/src/persistence/db/db-definition.embedded.ts` (AUTO-GENERATED — never hand-edit).
3. `cp spec/metamodel/db.json server/python/src/metaobjects/spec_metamodel/db.json && cp spec/metamodel/db.json server/csharp/MetaObjects/SpecMetamodel/db.json` (Java needs no copy — its pom bundles the root spec).
4. `bun run scripts/regen-expected-registry.ts` → diff must be confined to the `@role` attr block.
5. `bun run scripts/regen-metamodel-docs.ts` → `fixtures/metamodel-docs/expected/`, diff confined to the `@role` row.
6. Per-port constants — **DELETE the four, shrink the arrays** (verified inventory; nothing else reads them):
   - TS `.../persistence/source/source-constants.ts` L117–127: the four consts + `SOURCE_ROLES`.
   - Java `.../source/MetaSource.java` L132–142 (+ Javadoc L58); `.../source/RdbSource.java` L103–107 → `withEnum(ROLE_PRIMARY, ROLE_REPLICA)`.
   - C# `.../Persistence/Source/SourceConstants.cs` (~L170s); **`SourceSchema.cs` L69–70** — C# carries the description **in code**; it must byte-match the new db.json description. `grep "system of record"` to catch them all.
   - Python `.../meta/persistence/source/source_constants.py` L110–121 (registration via `core_types.py` L629 `allowed_values=SOURCE_ROLES`); grep `"Role this source plays"` in case Python also carries the string in code.
   - Tests: `server/java/metadata/src/test/java/com/metaobjects/source/MetaSourceTest.java` L352–355; then grep each port's test tree for stragglers.
7. **New fixture (+1):** `fixtures/conformance/error-source-role-reserved/` — `source.rdb` with `@role: "publish"` → `ERR_BAD_ATTR_VALUE` (generic allowedValues check; model `expected-errors.json` on `error-attr-bad-allowed-value`).
8. Doc sweep: `grep -rn "publish" docs/features agent-context spec/*.md | grep -i role` (historical plan docs stay — plans are records).

### C.3 TDD order

Fixture (step 7) first — run one port's conformance runner, watch it RED on the still-six-member registry, then steps 1–6, watch all five go GREEN.

### C.4 Gates (verbatim)

```bash
cd server/typescript/packages/metadata && bun test test/registry-conformance.test.ts test/conformance.test.ts test/metamodel-docs-conformance.test.ts
cd server/java && mvn -pl metadata -Dtest='RegistryManifestConformanceTest,ConformanceTest' -Dsurefire.failIfNoSpecifiedTests=false test
cd server/java && mvn -pl codegen-kotlin -am -Dtest='RegistryManifestConformanceTest' -Dsurefire.failIfNoSpecifiedTests=false test
cd server/python && uv run pytest tests/conformance/test_registry_conformance.py tests/conformance/test_conformance.py -q
cd server/csharp && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj
cd <repo-root> && bun run --filter '*' build && bun run --filter '*' typecheck
cd server/typescript/packages/codegen-ts && bun test test/golden/      # meta gen no-churn proof
```

### C.5 Byte-identical

`expected-registry.json` diff **only** in the `@role` block; `fixtures/metamodel-docs/expected/` diff **only** in the `@role` row; **all** codegen golden output byte-identical (roles never dispatch — the golden suite is the proof).

### C.6 Stop-and-escalate

Adopter-scan hit · registry diff wider than the `@role` block (provider-composition leak) · any non-test read of a deleted constant outside the verified inventory (a consumer dispatch appeared — the ruling's re-entry bar firing; report, don't delete).

### C.7 Close #212

Receipt: the ADR-0007 amendment commit (`91de3a85`), the shrink commit, and the note that the eventing surface (`api.eventing`/`operation.event`/`binding.messaging`) rides FR-024 to 1.1 (additive-by-construction — unregistered today).

---

## Unit D — #210: retire assembly origins on `object.value`; widen `@payloadRef`/`@responseRef`

**Ruling:** `origin.aggregate|computed|collection|first` become illegal on a value-hosted field; `origin.passthrough` **stays** (FR-015 parameter lineage — the loader already draws the line: "FR-024 B5" in every port's `validateOriginPaths`). `@payloadRef`/`@responseRef` widen to accept a **sourceless** `object.projection`. No new vocabulary, but `expected-registry.json` changes — `object.value`'s byte-checked `rules` string (the "by assembly" sentence). Durable rule: **"passthrough on a value is lineage; assembly origins live on projections."**

### D.0 Gate 0 — #271 disposition (BLOCKING)

The ruling names **two** preludes: #270 (Unit A) **and #271**. `gh issue view 271`.

> **NOTE (2026-08-06):** #271's pins landed in `efe12d43` (sourceless-projection conformance fixture + per-port codegen no-op tests, all five ports green) and its falsifier was **retired** — every port accepts a sourceless projection with **no new vocabulary**. A follow-on loader guard shipped in `bdeb4765` (`ERR_PROJECTION_INHERITED_SOURCE`). Verify (`git log --oneline --grep 271`), then either close #271 or record its remaining scope. If anything material is outstanding, **STOP and ask.**

Reversal trigger to keep live: **if any port needs new vocabulary to handle a sourceless projection, that's an ADR-0023 cost-class event — reopen the ruling, don't invent an attr.**

### D.1 Premise recon (anchors verified @ `2caa9684`)

- Value-host exemption (B5): TS `.../metadata/src/loader/validation-passes.ts` `validateOriginPaths` (`isValueHost` ~L1034); Python `validation_passes.py` ~L1861–1864; Java `ValidationPhase.java` ~L1911–1913; C# `ValidationPasses.cs` ~L409–413. Kotlin inherits the JVM loader.
- `@payloadRef` value checks: TS `validation-passes.ts` L246–266 (+`@responseRef` L268–280); Python ~L3140; Java ~L2866–2993 (rule R2); C# ~L2952–2957.
- Codegen-side "must be value" sites (all widen consistently):
  ```bash
  grep -rn "does not resolve to an object.value" server/ --include='*.ts' --include='*.py' --include='*.cs' --include='*.java' --include='*.kt' | grep -vE 'target/|obj/|bin/|dist/|node_modules/'
  ```
  Known @ baseline: Python `render_helper_generator.py`, `trace_helper_generator.py`; Java `LlmTraceHelperGenerator.java`; C# `PayloadCodegen.cs`. Plus subtype-filtered resolvers: Python `payload_vo_generator.resolve_payload_vo` L146; Kotlin `KotlinGenUtil.kt` L82 (`takeIf { subType == SUBTYPE_VALUE }`); TS `payload-codegen.ts` ~L106; Java `SpringPayloadGenerator.java`; C# `PayloadCodegen.cs`.
- The `rules` string: `spec/metamodel/object.json` (grep `"by assembly"`) + three copies — TS `.../core/object/object-definition.embedded.ts`, `server/python/src/metaobjects/spec_metamodel/object.json`, `server/csharp/MetaObjects/SpecMetamodel/object.json`; manifest `expected-registry.json` ~L3160. Verified: **no port carries this string in code** (unlike C#'s `@role` description) — re-grep `"by assembly"` across `server/` to confirm.

### D.2 Design decisions locked in advance

- **Error code: `ERR_SUBTYPE_RULE_VIOLATION`** (the ADR-0028/FR-024 value-purity code; precedent `fixtures/conformance/error-value-with-source`). **No new code expected** ⇒ the ledger ritual should be a no-op; if implementation forces a new code, execute it in full.
- **"Sourceless" must mean what #248's persistability-from-source contract means** — a declared **or inherited** `source.*` child. Do not invent a second definition. Note that as of `bdeb4765` a concrete projection may no longer **inherit** a source at all (`ERR_PROJECTION_INHERITED_SOURCE`), so "sourceless" is now unambiguous for projections: no own source. Confirm that still holds.
- **Sourced projection as `@payloadRef` target stays illegal** → `ERR_INVALID_TEMPLATE`; update the message once, apply identically in all four loaders (e.g. "does not resolve to an object.value or sourceless object.projection at root"), then grep every port's **tests** for the old message text.
- Payload emitters iterating a projection's fields must use **resolving** accessors (ADR-0039) — projection fields are frequently extends-bound; an own-only walk emits an empty payload. Verify per port.

### D.3 Files + change spec

1. **Loader (4 ports):** in each `validateOriginPaths`, value-hosted `aggregate|computed|collection|first` → `ERR_SUBTYPE_RULE_VIOLATION` (envelope pointing at the `origin.*` node, matching `error-value-with-source`'s shape). B5 passthrough exemption untouched. Locate **all four** subtype branches per port — `computed`/`first` may validate in separate blocks.
2. **Loader widen (4 ports):** `@payloadRef`/`@responseRef` accept `object.value` OR sourceless `object.projection`.
3. **Codegen resolvers widen (5 ports):** every site from D.1 + the subtype-filtered resolvers. Decide deliberately whether **nested** payload targets widen too (Kotlin `nestedTargetOf` `@objectRef` branch ~L410); the ruling only widens template-level refs, so **default: nested stays value-only** — note it in the commit.
4. **Rules string:** rewrite `object.value`'s `rules` in `spec/metamodel/object.json` (drop "by assembly"; passthrough-on-a-value is FR-015 parameter lineage; assembly origins live on projections). Optionally add the complement to `object.projection`'s rules. Then the **same pipeline as Unit C** (steps 2–5).
5. **Conformance fixtures (+6):**
   - `error-value-origin-aggregate` / `-computed` / `-collection` / `-first` — each: an `object.value` field hosting that origin → `ERR_SUBTYPE_RULE_VIOLATION`.
   - `template-payload-ref-sourceless-projection` — positive: `@payloadRef` → a sourceless `object.projection` loads clean.
   - `error-template-payload-ref-sourced-projection` — `@payloadRef` → a projection **with** `source.rdb` → `ERR_INVALID_TEMPLATE`.
   - `error-template-payload-ref-not-value` **stays as-is** (its input targets an `object.entity` — still an error; only its meaning narrows; expected-errors pins code+source, not message — verify).
   - Value+passthrough positive coverage already exists: `parameter-ref-with-origin-passthrough`.
6. **Re-host Unit A's fixtures (do not skip):** `server/java/codegen-kotlin/src/test/resources/fixtures/payload-with-origins/meta.json` hosts `origin.aggregate` on an `object.value` (`AuthorReport`) — now illegal. Re-host as a **sourceless `object.projection`** (snapshot regenerates — an **expected, justified** change in this unit, unlike Unit A). Same for Unit A's disagreement fixtures if they host `origin.collection` on a value, and Python's `_value_object` + `_collection` test helpers. Sweep:
   ```bash
   grep -rln "object.value" fixtures/ examples/ server/*/*/src/test 2>/dev/null | xargs grep -l "origin.aggregate\|origin.collection\|origin.computed\|origin.first" 2>/dev/null
   ```
7. **Docs:** ADR-0028 amendment (the durable rule, one paragraph); `spec/roadmap.md` #210 → shipped; migration guide `docs/features/migrations/value-assembly-origins-and-source-role-shrink.md` (covers both breaking changes of Release 2; precedent `identity-secondary-to-index-lookup.md`); agent-context sweep: `grep -rni "origin.aggregate\|origin.collection" agent-context/ docs/features/ | grep -i value`.

### D.4 TDD order

Fixtures (5) RED on all five runners → loader change (1–2) per port, TS first as reference → per-port widen unit tests → resolver change (3) → rules-string pipeline (4), registry runners RED → GREEN → re-hosting (6) → docs (7).

### D.5 Gates

All Unit C gate commands, **plus**:

```bash
cd server/typescript/packages/metadata && bun test
cd server/typescript/packages/codegen-ts && bun test && bun test test/golden/
cd server/java && mvn -pl metadata -am test
cd server/java && mvn -pl codegen-spring -am test
cd server/java && mvn -pl codegen-kotlin -am test
cd server/python && uv run pytest -q          # integration lane: uv run --extra integration pytest -q
cd server/csharp && dotnet test MetaObjects.sln
cd <repo-root> && bun run --filter '*' build && bun run --filter '*' typecheck
```

### D.6 Byte-identical

`expected-registry.json` diff confined to the `object.value` (and optionally `object.projection`) `rules` strings, **on top of** Unit C's `@role` block; `fixtures/metamodel-docs/expected/` likewise; all golden/codegen output byte-identical except the re-hosted `payload-with-origins`.

### D.7 Stop-and-escalate

#271 unresolved · "sourceless" ambiguous vs the #248 contract · the rules string found carried in any port's **code** · real adopter metadata using assembly origins on payload VOs (the ruling's first reversal trigger) · any port needing new vocabulary (ADR-0023 ⇒ reopen).

---

## Batch review + Release 2 — `0.21.0` / `7.21.0` (coordinated MINOR, breaking)

1. Units C+D on one branch (`feat/0.21-role-shrink-and-210`, C then D as separate commits) → `no-mistakes` gate with a rich `--intent` naming both rulings → merge to `main` → push → watch local-ci across **all** ports.
2. **Fixture-count propagation** (one commit): recount `ls -d fixtures/conformance/*/ | wc -l` (arithmetic says 262 + 1 + 6 = **269** — trust the count, not the arithmetic). Surfaces: `docs/CONFORMANCE.md` L28 (matrix row) **and** L72 (section heading); `CLAUDE.md` ~L35; `README.md` ~L169; `spec/roadmap.md` ~L78; `docs/llms/llms.txt` ~L34; `docs/llms/llms-full.txt` ~L102; **and the site mirror** — sibling checkout `../metaobjectsdev.github.io/www/llms{,-full}.txt` (separate repo, GitHub Pages; commit + push there; never re-run a failed Pages deploy).
3. `CHANGELOG.md` `[0.21.0]`: **BREAKING** — (a) assembly origins on an `object.value`-hosted field now fail load with `ERR_SUBTYPE_RULE_VIOLATION` (passthrough stays — FR-015 lineage); (b) `@role` members `index`/`cache`/`publish`/`mirror` retired to reserved-not-registered — a legacy use now fails `ERR_BAD_ATTR_VALUE`. **Additive** — `@payloadRef`/`@responseRef` accept a sourceless `object.projection`. Link the migration guide.
4. Release all four registries. Post-release docs-propagation commit.
5. Close #210 (receipt: fixture names + registry diff + migration guide); verify #212 closed; record #271's disposition.

---

## Cross-cutting rituals

### Error-code ledger (only if a new code is minted — none expected)
`fixtures/conformance/ERROR-CODES.json` → TS `.../metadata/src/errors.ts` (exact-bidirectional; a test enforces) → Python `.../metaobjects/errors.py` (superset) → Java `.../com/metaobjects/ErrorCode.java` → C# `.../MetaObjects/Errors.cs`.

### Registry-change pipeline (Units C and D — always this order)
edit `spec/metamodel/*.json` → `bun run scripts/generate-embedded-metamodel.ts` → `cp` changed spec files to `server/python/src/metaobjects/spec_metamodel/` and `server/csharp/MetaObjects/SpecMetamodel/` → `bun run scripts/regen-expected-registry.ts` → `bun run scripts/regen-metamodel-docs.ts` → reconcile per-port code carriers (C# `SourceSchema.cs`-style inline strings; Java `withEnum` lists) → run all five registry runners. Java needs no copy; Kotlin composes from the JVM registry.

### Known cross-port asymmetries
- C# carries the `@role` **description in code** (`SourceSchema.cs`); the `object.value` **rules string is data-only** in every port. Grep before assuming either way for any other string.
- Python's own-vs-resolving naming inversion: `attr()` is OWN in Python, resolving in TS (ADR-0039).
- `bun test` ignores bunfig timeout config — use `--timeout` if a cold-start flake appears; re-runs don't fix ts-fast cold-start timeouts.
- Hosted-CI red with local green usually means the local box is *warm* (built `dist/`, warm `~/.m2`) — reproduce by removing the warmth.

---

## Appendix — verified file inventory (@ `2caa9684`; re-verify before editing)

| Concern | Path |
|---|---|
| Kotlin payload generator | `server/java/codegen-kotlin/.../KotlinPayloadGenerator.kt` (dispatch ~L163–230; `resolveCollectionType` L363–403) |
| Kotlin closure / extract | same dir: `KotlinGenUtil.kt` (~L367/~L394–410), `KotlinExtractorGenerator.kt`, `KotlinExtractMapperEmitter.kt`, `KotlinOutputParserGenerator.kt` |
| Kotlin payload tests + snapshot | `.../src/test/kotlin/.../KotlinPayloadGeneratorTest.kt`, `KotlinExtractTierCollisionTest.kt`; `.../src/test/resources/{fixtures,snapshots}/payload-with-origins/` |
| Python payload generator + closure | `server/python/src/metaobjects/codegen/generators/payload_vo_generator.py` (L313–560), `.../codegen/collision_names.py` |
| Python extract tier + tests | `.../generators/{extractor_generator,output_parser_generator}.py`; `server/python/tests/codegen/test_payload_vo_generator.py` (pathology ~L290–316), `test_extract_tier_collision.py` |
| Loader validation (4 ports) | TS `.../metadata/src/loader/validation-passes.ts` (payloadRef L246–280; `validateOriginPaths` L1026+); Python `validation_passes.py` (~L1861, ~L3140); Java `ValidationPhase.java` (~L1911, ~L2866+); C# `ValidationPasses.cs` (~L409, ~L2952) |
| `@role` vocabulary | `spec/metamodel/db.json` L44; `expected-registry.json` ~L3741–3747; TS `.../persistence/db/db-definition.embedded.ts` + `.../persistence/source/source-constants.ts` L117–127; Java `.../source/MetaSource.java` L132–142 + `RdbSource.java` L103–107 + `MetaSourceTest.java` L352–355; C# `.../Persistence/Source/SourceConstants.cs` + `SourceSchema.cs` L69–70; Python `.../source/source_constants.py` L110–121 + `core_types.py` L629 |
| `object.value` rules string | `spec/metamodel/object.json`; TS `.../core/object/object-definition.embedded.ts`; Python `.../spec_metamodel/object.json`; C# `.../SpecMetamodel/object.json`; manifest `expected-registry.json` ~L3160 |
| Regen scripts | `scripts/generate-embedded-metamodel.ts`, `scripts/regen-expected-registry.ts`, `scripts/regen-metamodel-docs.ts` |
| Conformance runners | TS `.../metadata/test/{conformance,registry-conformance,metamodel-docs-conformance}.test.ts`; Java `.../metadata/src/test/java/com/metaobjects/{conformance/ConformanceTest,registry/RegistryManifestConformanceTest}.java`; Kotlin `.../codegen-kotlin/src/test/kotlin/.../RegistryManifestConformanceTest.kt`; Python `server/python/tests/conformance/{test_conformance,test_registry_conformance}.py`; C# `server/csharp/MetaObjects.Conformance.Tests/` |
| Fixture-count surfaces | `docs/CONFORMANCE.md` L28+L72 · `CLAUDE.md` ~L35 · `README.md` ~L169 · `spec/roadmap.md` ~L78 · `docs/llms/llms.txt` ~L34 · `docs/llms/llms-full.txt` ~L102 · sibling checkout `../metaobjectsdev.github.io/www/llms{,-full}.txt` |
| Error ledger | `fixtures/conformance/ERROR-CODES.json` · TS `.../metadata/src/errors.ts` · Python `.../metaobjects/errors.py` · Java `.../com/metaobjects/ErrorCode.java` · C# `.../MetaObjects/Errors.cs` |
| Docs closure (#270) | `CLAUDE.md` ~L555 · `server/java/codegen-spring/.../KNOWN_GAPS.md` · `server/java/codegen-kotlin/.../KNOWN_GAPS.md` |
