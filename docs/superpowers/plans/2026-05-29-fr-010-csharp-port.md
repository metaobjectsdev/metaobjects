# FR-010 C# port — native recover engine + OutputFormatRenderer + codegen

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development + cross-language-porting. Steps use checkbox (`- [ ]`). Java (`server/java/render/.../recover/` + `.../prompt/`) is the reference; the conformance corpus is the ORACLE (`fixtures/recover-conformance/`, `fixtures/conformance/template-output-{xml,json}-simple/`). Reimplement idiomatically (Tier-2); never change Tier-1 (classification, vocabulary, rendered output, wire format).

**Goal:** Bring FR-010 to the C# port. Unlike Kotlin (which shares the JVM engine), .NET must **natively reimplement** the recover engine + the output-format prompt renderer, then add the codegen + metamodel attrs — kept aligned to the shared conformance corpus.

**Why three phases (each a separate merge):**
1. **Recover engine + dirty-input conformance** — `MetaObjects.Render/Recover/*` reimplemented from the Java reference; a `RecoverConformanceTests` runs `fixtures/recover-conformance/` and is the correctness gate. (≈ Java Plan 1.)
2. **OutputFormatRenderer** — `MetaObjects.Render/Prompt/*` (3 comment-free styles × xml/json) reimplemented; render parity. (≈ Java Plan 3's renderer.)
3. **Metamodel attrs + codegen + clean fixtures** — register `@enumAlias`/`@promptStyle`/`@example`/`@instruction`/`@enumDoc` in the C# loader; extend the C# `OutputParserGenerator` with `Recover`/`TryRecover`; add an output-prompt generator; clean fixtures. (≈ Java Plans 2+3 codegen.)

**Tech stack:** C# / .NET 8, `MetaObjects.Render` (+ `MetaObjects.Codegen` in phase 3), System.Text.Json, xUnit, `#nullable enable`, `TreatWarningsAsErrors=true`. Reuse the existing `Escapers.cs` (format-keyed escaping) for the renderer.

## Tier decisions (cross-language-porting)
- **Tier 1 (invariant — must match the corpus):** the `FieldRecovery` classification per field (`RECOVERED|DEFAULTED|LOST_OPTIONAL|LOST_REQUIRED|MALFORMED`) + the `empty` flag + the canonical normalized value (numeric ±1e-9); the recover pipeline's observable behavior (strip/locate/forgiving-read/malformed-vs-absent/coerce); the rendered fragment (comment-free, valid, the 3 styles); `@promptStyle`/`@enumAlias`/`@enumDoc` vocabulary; the `MALFORMED`/`TRUNCATED` sentinels' *effect* on classification.
- **Tier 2 (idiomatic — C#):** `Recover.Recover(text, schema, opts=null)` static, never throws (single method, closest to Java; the dual Parse/TryParse stays the FR-006 strict tier). Records for the data model (`RecoverSchema`, `FieldSpec`, etc.); `RecoveryReport` a mutable class. PascalCase method names; `object?` for the forgiving map values; `IReadOnlyList`/`IReadOnlyDictionary` on public APIs. Enum *members* keep the Java SCREAMING_SNAKE names where they're serialized in `schema.json`/`expected.json` (so the corpus deserializes) — confirm against the fixture format. Generated recover returns `RecoveryResult<TRecovered>` with a nullable mirror record (same Kotlin-style reasoning: C# `required` init properties can't take null for a lost required field — phase 3 decision).
- **Tier 3 (free):** file layout, internal mechanism, the conformance runner's plumbing.
- **Bounded deferral:** nested-object recover/prompt mapping (same as Java/Kotlin).

---

## PHASE 1 — recover engine + dirty-input conformance (this plan, detailed)

Port the 13 recover classes to `MetaObjects.Render/Recover/` idiomatically, then prove against the corpus. **The corpus is the oracle: when a case is red, ask "should it match?" before "how do I make it match"; never edit a fixture to match the port — escalate a suspected-wrong fixture.**

### C1-T1: data model (enums + records)
Port `Format`, `FieldKind`, `FieldRecovery`, `Tolerance`, `Coercion`, `FieldSpec`, `RecoverSchema`, `RecoverOptions`, `RecoverOutcome`, `RecoveryResult`, `RecoveryReport` to C# under `MetaObjects.Render/Recover/`. Records for the immutable ones; `RecoveryReport` a mutable class with `Set/AddCoercion/MarkEmpty/States()/Coercions()/LostRequired()/Malformed()/HasLostRequired()/IsEmpty()`. Enum members match Java names (`RECOVERED` etc.) — but C# enum identifiers can't be `LOST_REQUIRED`? they can (underscores allowed). Keep the Java names for serialization parity; if the fixture `expected.json` uses `LOST_REQUIRED`, the C# enum member is `LOST_REQUIRED` (valid C#). `FieldSpec` static factories `Scalar/EnumField/Range/Object`. **Test:** a `ModelTests` mirroring the Java `ModelTest`/`ReportTest`.

### C1-T2: `Strip` (stage 1) — fence removal. Port `Strip.strip`; regex (`System.Text.RegularExpressions`). Test mirrors `StripTest`.

### C1-T3: `Locate` (stages 2–3) — `Json(text)` balanced-brace (string-aware) + `Xml(text, rootName, caseInsensitive)`; first-closed-else-first-open. Port + test (mirror `LocateTest`, incl. the no-throw-on-`</x>` guard `rootEnd <= gt`).

### C1-T4: `JsonForgivingReader` — tolerant JSON → `Dictionary<string, object?>`; trailing commas, single/unquoted, **TRUNCATED sentinel** for present-but-empty/cut-off, no-hang on `{"xs":[}`. Port the FIXED Java version (incl. the no-hang + TRUNCATED behavior). Test mirrors `JsonForgivingReaderTest` (incl. timeout-style no-hang + truncated-marks-sentinel).

### C1-T5: `XmlForgivingReader` — tolerant XML → map; unclosed-tag recovery, attr-quote variants, case-folding, no-throw on close-tag-start. Port the FIXED version. Test mirrors `XmlForgivingReaderTest`.

### C1-T6: `Coerce` (stage 7) — enum alias/vocab (runtime-alias-wins), numeric range clamp, **non-finite → MALFORMED**, boolean forms, onField hook, normalizers. Port the FIXED version (incl. the `!double.IsFinite` guard). `MALFORMED` sentinel = `static readonly object Malformed = new()`. Test mirrors `CoerceTest`.

### C1-T7: `Recover` entry + `RecoverMap` + classify — assemble strip→locate→read→extract→classify→coerce; array handling (partial-MALFORMED keeps elements); object-given-scalar → MALFORMED; TRUNCATED→MALFORMED; empty-guard. `RecoverMap.AsString/AsInt/AsLong/AsDouble/AsBool/AsStringList` null-safe. Test mirrors `RecoverTest` (all the distinctions: absent→LOST_*, present-empty→MALFORMED, alias-fold, array partial).

### C1-T8: dirty-input conformance runner
`MetaObjects.Render.Tests/RecoverConformanceTests.cs` — an xUnit `[Theory]` walking `fixtures/recover-conformance/` (locate the repo-root by walking up from the test base dir, like the Java runner). For each case: deserialize `schema.json` → `RecoverSchema` (a small JSON→schema parser matching the Java runner's `parseSchema`/`parseField`), read `input.txt`, run `Recover.Recover`, assert `expected.json`'s `empty` + `states` (per-field classification, EXHAUSTIVE key-set) + `data` (canonical; doubles ±1e-9). All 10 cases must match. **If a case is red, diagnose whether the C# behavior or the fixture is right — do NOT edit the fixture to match; escalate a suspected-wrong fixture.**

### C1-T9: review + simplify + regression
`dotnet test MetaObjects.Render.Tests` green incl. the corpus; final review + simplifier; KNOWN_GAPS note (nested deferral). Merge phase 1.

---

## PHASE 2 — OutputFormatRenderer (outline; detailed when phase 1 lands)
Port `MetaObjects.Render/Prompt/{PromptStyle,OutputFormatSpec,PromptField,PromptOverrides,OutputFormatRenderer}` — the 3 comment-free styles (guide/inline/exampleOnly) × xml/json, reusing `Escapers.cs`. Tests mirror the Java renderer tests (comment-free, valid JSON via `System.Text.Json` parse, the NaN→quoted fix, the GUIDE+JSON extraction). C#-specific: no `$`-interpolation hazard (that was Kotlin) but watch `{`/`}` in `$"..."` interpolated strings if used — prefer plain concatenation/`StringBuilder` in the emitters.

## PHASE 3 — metamodel attrs + codegen + clean fixtures (outline)
1. Register `@enumAlias`/`@enumDoc` (properties — `ATTR_SUBTYPE_PROPERTIES` exists), `@example`/`@instruction` (string), `@promptStyle` (closed enum on template.output — mirror how C# enforces `@format`'s allowed set). Add the C# constants.
2. A `RecoverSchemaEmitter` + `OutputFormatSpecEmitter` (C#) emitting the descriptor literals; extend `OutputParserGenerator` with `Recover`/`TryRecover` returning `RecoveryResult<TRecovered>` (nullable mirror record — C# `required` init can't take null for a lost required field, same reasoning as Kotlin); new output-prompt generator emitting `RenderFormat([overrides])`.
3. Clean fixtures conformance (C# expected) + a compile/behavioral check if feasible.

---

## Self-review (phase 1)
- All 13 recover classes ported; corpus 10/10 green (the oracle); classification + canonical-value asserted (not raw bytes); the FIXED Java behaviors carried (no-hang JSON, XML no-throw, non-finite MALFORMED, TRUNCATED→MALFORMED, array partial); never-throws; nested deferred.
- Verify-against-live-code: the C# attr-read API (`MetaData.OwnAttr`), the xUnit `[Theory]` fixture-walk idiom, the `Escapers` API (phase 2), the repo-root-walk for fixtures.
