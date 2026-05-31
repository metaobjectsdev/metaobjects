# `recover` → `extract` Cross-Port Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Mechanical rename — the gate is **existing tests stay green AND zero case-insensitive "recover" remains**, not new tests.

**Goal:** Eliminate "recover" from the entire library, renaming into the `extract` family, across all 5 ports + fixtures + docs + ADRs. Pure rename, no behavior change, no aliases.

**Architecture:** Per-port mechanical rename (symbols + files + packages/dirs + imports), each port verified by its own full test + conformance suite staying green. The shared `fixtures/recover-conformance/` corpus + all path references are renamed in a final coordinated step so no port is left dangling. Spec: `docs/superpowers/specs/2026-05-31-recover-to-extract-rename-design.md`.

**Tech Stack:** sed/grep-driven rename per language; build + test per port. Worktree `worktree-recover-to-extract-rename` off origin/main, single branch, single merge.

---

## The canonical rename map (apply in EVERY port, case-adjusted per convention)

Identifier substitutions (longest-match first to avoid partial clobbering):
- `MetaObjectRecover` → `MetaObjectExtractor`
- `RecoverSchemaEmitter` → `ExtractSchemaEmitter`; `KotlinRecoverSchemaEmitter` → `KotlinExtractSchemaEmitter`; `RecoverDelegateEmitter` → `ExtractDelegateEmitter`
- `RecoverSchema` → `ExtractSchema`; `recoverSchemaFor`/`recover_schema_for` → `extractSchemaFor`/`extract_schema_for`; `buildRecoverSchema`/`_build_recover_schema` → `buildExtractSchema`/`_build_extract_schema`
- `RecoverMap` → `ExtractMap`; `recover_map` → `extract_map`
- `RecoverOptions` → `ExtractOptions`
- `RecoveryResult` → `ExtractionResult`
- `RecoveryReport` → `ExtractionReport`
- `RecoverOutcome` → `ExtractionOutcome`
- `RecoverEngine` → `ExtractEngine`
- `RecoverObject`/`recoverObject`/`recover_object` → `ExtractObject`/`extractObject`/`extract_object`
- `RecoverException` → `ExtractException` (already exists from the extractor work — converge, don't duplicate); `RecoverError` → `ExtractError`
- `FieldRecovery` → `FieldExtraction`
- `RECOVERED` → `EXTRACTED`
- mirror type suffix `Recovered` → `Extracted` (`<Name>Recovered` → `<Name>Extracted`, `recoveredClass`→`extractedClass`, `recoveredType`→`extractedType`, `recoveredName`→`extractedName`, `recoveredCtorArgs`→`extractedCtorArgs`, `nestedRecoveredClass`→`nestedExtractedClass`, `rootRecoveredClass`→`rootExtractedClass`)
- **the never-throws public tier verb** `recover<Name>`/`recover_<snake>` → `extractLenient<Name>`/`extract_lenient_<snake>`; the bare engine verb `recover(` → `extract(`; `recoverWithName`/`recover_with_fn`/`recoverFnName` → `extractLenientWithName`/`extract_lenient_with_fn`/`extractLenientFnName` (the codegen'd public verb); the `…WithLoader`/`…_with_loader` suffix stays
- `emitRecover`/`emit_recover` → `emitExtractLenient`/`emit_extract_lenient` (codegen of that verb); `recoverMethod`→`extractLenientMethod`; `recoverMapCall`/`RecoverMapCall` → `extractMapCall`/`ExtractMapCall`; `recoverMapHelper(s)`→`extractMapHelper(s)`; `formatSupportsRecover`→`formatSupportsExtract`; `recoverable`→`extractable`; `unrecoverable`→`unextractable`; `norecover`→`noextract`
- test classes/files: `RecoverConformanceTest(s)`→`ExtractConformanceTest(s)`; `RecoverTest`→`ExtractTest`; `RecoverSchemaEmitterTest`→`ExtractSchemaEmitterTest`; `recover-conformance.test.ts`→`extract-conformance.test.ts`; `test_recover_*`→`test_extract_*`
- packages/dirs: `…/recover/` → `…/extract/`; namespaces `…Recover` → `…Extract`; Python `object_recover.py`→`object_extract.py`, `recover_schema_emitter.py`→`extract_schema_emitter.py`, `recover_delegate_emitter.py`→`extract_delegate_emitter.py`, `test_recover_conformance.py`→`test_extract_conformance.py`

**Disambiguation:** `extract<Name>` (strict, throws on lost-required) already exists — do NOT rename it. Only the never-throws tier becomes `extractLenient<Name>`. The engine's low-level verb (takes a schema) becoming `extract(` is fine (different layer/module from the codegen `extract<Name>`).

**Leave the fixture PATH string `fixtures/recover-conformance` alone in per-port tasks** (Tasks 1-4) — it is renamed in Task 5 along with every reference, so no port dangles mid-stream.

**Per-port gate:** after the rename, `grep -rin recover server/<port>` returns EMPTY (zero case-insensitive "recover"), EXCEPT the literal fixture path `recover-conformance` (handled in Task 5). And the port's full test + conformance suite is green.

---

## Task 1: JVM (Java + Kotlin — shared render/om engine)

Java and Kotlin share the JVM render engine (`com.metaobjects.render.recover`) and `om` (`com.metaobjects.object.recover`); Kotlin codegen reuses them — so they rename together.

**Modules:** `server/java/{metadata,render,om,codegen-base,codegen-mustache,codegen-spring,codegen-kotlin,integration-tests,integration-tests-kotlin}` (whichever contain matches).

- [ ] **Step 1:** Apply the rename map across all `*.java` + `*.kt` under `server/java`: identifier substitutions, then `git mv` the package dirs `com/metaobjects/render/recover` → `…/render/extract` and `com/metaobjects/object/recover` → `…/object/extract`, update `package`/`import` statements, and `git mv` renamed files (`*Recover*.java/.kt` → `*Extract*`). Use longest-match-first ordering. Leave the `recover-conformance` fixture path string.
- [ ] **Step 2:** `cd server/java && mvn -pl metadata,render,om install -DskipTests` then `mvn test` across the affected modules. All green (render recover-conformance still points at the old fixture path — fine, Task 5 renames it).
- [ ] **Step 3:** Gate: `grep -rin recover server/java | grep -v recover-conformance` → EMPTY.
- [ ] **Step 4:** Commit (`refactor(jvm): rename recover→extract (extractLenient tier, render.extract/object.extract packages)`).

## Task 2: C#

**Project:** `server/csharp/MetaObjects*`.

- [ ] **Step 1:** Apply the rename map across `*.cs`; `git mv` the `Recover/` dirs → `Extract/`, rename namespace `…Recover` → `…Extract`, update `using`s, `git mv` `*Recover*.cs` → `*Extract*`. Converge on the existing `ExtractException`. Leave the fixture path.
- [ ] **Step 2:** `cd server/csharp && dotnet test` (all test projects). Green.
- [ ] **Step 3:** Gate: `grep -rin recover server/csharp | grep -v recover-conformance` → EMPTY.
- [ ] **Step 4:** Commit (`refactor(csharp): rename recover→extract (extractLenient tier, Extract namespace)`).

## Task 3: TypeScript

**Packages:** `server/typescript/packages/{render,runtime-ts,codegen-ts,...}`.

- [ ] **Step 1:** Apply the rename map across `*.ts`; `git mv` `src/recover/` → `src/extract/`, rename `recover-*.ts` files → `extract-*.ts`, update import specifiers. The strict `extract<Name>` stays; `recover<Name>`→`extractLenient<Name>`, `tryRecover<Name>`→`tryExtractLenient<Name>`, `recover<Name>WithLoader`→`extractLenient<Name>WithLoader`. Leave the fixture path.
- [ ] **Step 2:** `cd server/typescript && bun test`. Green (full server suite).
- [ ] **Step 3:** Gate: `grep -rin recover server/typescript --include=*.ts | grep -v recover-conformance` → EMPTY.
- [ ] **Step 4:** Commit (`refactor(codegen-ts): rename recover→extract (extractLenient tier, extract/ module)`).

## Task 4: Python

**Package:** `server/python/src/metaobjects` + `tests`.

- [ ] **Step 1:** Apply the rename map across `*.py`; `git mv` `render/recover/` → `render/extract/`, `meta/core/object/object_recover.py` → `object_extract.py`, the emitter/test files; update imports. `recover_<snake>`→`extract_lenient_<snake>`, `recover_object`→`extract_object`, `recover_schema_for`→`extract_schema_for`. Leave the fixture path.
- [ ] **Step 2:** `cd server/python && python3 -m pytest tests` (excluding the pre-existing `tests/integration` optional-dep failures). Green.
- [ ] **Step 3:** Gate: `grep -rin recover server/python | grep -v recover-conformance` → EMPTY.
- [ ] **Step 4:** Commit (`refactor(runtime-py): rename recover→extract (extract_lenient tier, render/extract module)`).

## Task 5: Shared corpus + docs + closeout

- [ ] **Step 1:** `git mv fixtures/recover-conformance fixtures/extract-conformance`. Sweep every reference to the old path across all ports, `scripts/`, CI, docs: `grep -rln "recover-conformance\|recover_conformance" .` → update each to `extract-conformance`/`extract_conformance`. Rename any remaining `RecoverConformance*` test symbols missed.
- [ ] **Step 2:** Re-run EVERY port's conformance suite against the renamed corpus (JVM `mvn test` render+codegen-spring+codegen-kotlin; C# `dotnet test`; TS `bun test`; Python `pytest tests/conformance`). All green.
- [ ] **Step 3:** Repo-wide final gate: `grep -rin recover server fixtures scripts` → EMPTY (zero "recover" anywhere in code/fixtures/scripts). Docs: update `KNOWN_GAPS.md` (×5), `spec/roadmap.md`, ADRs, design docs — rename API references; reword prose. `grep -rin recover docs spec` → only acceptable historical/prose mentions, ideally empty.
- [ ] **Step 4:** Update memory (`cross-port-runtime-object-model.md`, `fr-010-plan-decisions.md`, `java-flavored-object-codegen.md`): mark the rename DONE; note `recover`→`extract`/`extractLenient`, `Recovery*`→`Extraction*`, corpus `extract-conformance`.
- [ ] **Step 5:** Final whole-branch review (mechanical-rename lens: no behavior change, zero "recover", all suites green, hygiene). Then forward-merge onto current origin/main (fetch; merge origin/main in if advanced; re-verify; FF-push). Remove worktree. Publish stays deferred.

---

## Notes for the executor
- **Longest-match-first** substitution ordering (e.g. `RecoverSchemaEmitter` before `RecoverSchema` before `Recover`) to avoid partial clobbering.
- **Do NOT rename the strict `extract<Name>`** tier — only `recover<Name>`→`extractLenient<Name>`.
- **`git mv` for file/dir renames** so history follows; update package/namespace/import statements to match.
- **Per-port gate is zero "recover"** (case-insensitive) except the fixture path until Task 5.
- Pure rename — if any test needs a VALUE changed (not just a symbol), that's a red flag; stop and report.
- Absolute worktree paths; confirm branch before commit; `mvn install` changed JVM modules before dependents.
