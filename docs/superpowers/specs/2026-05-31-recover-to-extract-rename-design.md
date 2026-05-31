# `recover` → `extract` Cross-Port Rename — Design

_Date: 2026-05-31. Status: design (pending user review of the symbol map). All 5 ports + docs + ADRs + conformance. No backwards compatibility (no aliases) — pre-GA._

## Why

"recover" carries the ecosystem's "recovery = retry-the-LLM-on-validation-error" sense (Instructor). MetaObjects never calls an LLM — the so-named tier is a **single-pass tolerant parse** that returns a best-effort partial + per-field report; it does not retry anything. The name is misleading. `extract` is the industry-standard term (LangChain/Instructor "structured extraction") and is already the headline tier we shipped. This rename **eliminates "recover" from the entire library** so the vocabulary is honest: `extract` (clean typed) / `tryExtract` (never-throws partial) / `parse` (strict).

## Mechanical-only

This is a pure rename — **no behavior change**. Every conformance corpus, compile-and-run proof, and unit test must stay green (byte-identical outputs, just renamed symbols/files). No aliases, no deprecation shims (pre-GA, no published consumers to break for the unpublished ports; the JVM is renamed wholesale too).

## The three tiers after the rename (public codegen API, per `template.output`)

| Tier | Semantics | Returns | Rename |
|---|---|---|---|
| `parse` | strict | throws on any malformation | unchanged |
| `extract` | tolerant → **clean typed** | strict payload; throws only on lost-required | unchanged (already `extract`) |
| **`extractLenient`** | tolerant → **never-throws partial** | `ExtractionResult<<Name>Extracted>` + report | **was `recover`** |

## Canonical symbol map (concept → new; per-port casing follows mechanically)

**Public verbs / generated symbols**
- `recover<Name>` / `recover_<snake>` / `recover` (never-throws tier) → `extractLenient<Name>` / `extract_lenient_<snake>` / `extractLenient`
- the nested-capable `…WithLoader` / `…_with_loader` variant keeps its suffix on the renamed verb
- TS thin ok-wrapper `tryRecover<Name>` (if present) → `tryExtractLenient<Name>` (or fold per-port; resolve exact set in the plan)
- mirror type `<Name>Recovered` → `<Name>Extracted`

**Engine + types (the tolerant-parse machinery, shared by both extract & tryExtract)**
- `Recover` engine class/module + its `recover()` method → `Extract` + `extract()`
- `RecoverEngine` → `ExtractEngine`
- `RecoverSchema` → `ExtractSchema`;  `recoverSchemaFor`/`recover_schema_for` → `extractSchemaFor`/`extract_schema_for`
- `RecoverMap` → `ExtractMap`
- `RecoverOptions` → `ExtractOptions`
- `RecoveryResult` → `ExtractionResult`
- `RecoveryReport` → `ExtractionReport`
- `RecoverOutcome` → `ExtractionOutcome`
- `MetaObjectRecover` → `MetaObjectExtractor`
- `RecoverObject` / `recoverObject` / `recover_object` (runtime entry) → `ExtractObject` / `extractObject` / `extract_object`
- `RecoverException` / `RecoverError` → `ExtractException` / `ExtractError`  (`ExtractException` already exists from the extractor work — reuse/converge)
- `FieldRecovery` → `FieldExtraction`  (verdict enum)
- verdict member `RECOVERED` → `EXTRACTED`  (siblings `DEFAULTED` / `LOST_OPTIONAL` / `LOST_REQUIRED` / `MALFORMED` unchanged)

**Emitters (codegen)**
- `RecoverSchemaEmitter` → `ExtractSchemaEmitter`
- `KotlinRecoverSchemaEmitter` → `KotlinExtractSchemaEmitter`
- `RecoverDelegateEmitter` → `ExtractDelegateEmitter`
- `recover-schema-emitter.ts` → `extract-schema-emitter.ts`, `recover-delegate-emitter.*` → `extract-delegate-emitter.*`, etc. (file renames track symbol renames)

**Conformance + tests**
- `fixtures/recover-conformance/` → `fixtures/extract-conformance/` (corpus dir; scenario subfolders unchanged)
- `RecoverConformanceTest(s)` → `ExtractConformanceTest(s)`; `recover-conformance.test.ts` → `extract-conformance.test.ts`; the Python `test_recover_conformance.py` → `test_extract_conformance.py`; etc.
- any test-runner / `scripts/` / CI references to the corpus path updated

**Package / directory move (structural — JUDGMENT CALL, flagged)**
- the engine package/dir `recover/` → `extract/` in each port:
  - Java/Kotlin: `com.metaobjects.render.recover` → `com.metaobjects.render.extract` (+ the `om` `com.metaobjects.object.recover`)
  - C#: `MetaObjects.Render/Recover/` (namespace `…Recover`) → `…/Extract/` (`…Extract`)
  - TS: `packages/render/src/recover/` → `packages/render/src/extract/`
  - Python: `metaobjects/render/recover/` → `metaobjects/render/extract/`, `meta/core/object/object_recover.py` → `object_extract.py`
  - This rewrites import paths everywhere — large but consistent with "no recover anywhere".

**Docs / ADRs / memory**
- `KNOWN_GAPS.md` (×5 ports), spec/roadmap, ADRs, design docs: prose + path references updated. `recover` as an English word in prose stays where it's describing generic recovery in non-API context — but API references rename.

## Execution

Per-port, single branch `worktree-recover-to-extract-rename`, single merge. Each port: rename symbols + files + package/dir + imports → build → run that port's full test + conformance suite (must stay green) → review. Then a cross-port pass: rename `fixtures/recover-conformance/` → `fixtures/extract-conformance/` + all corpus references, re-run every port's conformance against the renamed corpus. Finally docs/ADRs/roadmap/memory. Order: do the shared `fixtures/` corpus rename in lockstep with whichever port runs it, or as a coordinated final step so no port is left pointing at the old path.

## Out of scope
- Any behavior change (pure rename).
- Publish (deferred to explicit user confirm).
- Renaming non-API English uses of "recover"/"recovery" in prose where they don't denote the API.

## Resolved decisions (user, 2026-05-31)
1. **Never-throws partial tier → `extractLenient`** (`extractLenient<Name>` / `extract_lenient_<snake>`). Strict tier stays `extract`.
2. **Engine types: Extract\* (inputs/helpers) + Extraction\* (outputs)** — the 1:1 mapping of today's Recover\*/Recovery\* split (cleanest mechanical sweep): `RecoverMap→ExtractMap`, `RecoverOptions→ExtractOptions`, `RecoverSchema→ExtractSchema`, `RecoverEngine→ExtractEngine` vs `RecoveryResult→ExtractionResult`, `RecoveryReport→ExtractionReport`, `RecoverOutcome→ExtractionOutcome`.
3. **Move the packages/directories too** (`recover/` → `extract/`, namespaces/modules, `object_recover.py→object_extract.py`). Goal: **ZERO case-insensitive "recover" remaining in the tree** — symbols, files, packages, comments, test names, strings, prose (`recoverable`→`extractable`, etc.). The per-port gate is `grep -rin recover server/<port>` returning empty.
