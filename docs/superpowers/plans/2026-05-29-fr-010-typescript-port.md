# FR-010 TypeScript port — native recover engine + OutputFormatRenderer + codegen

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development + cross-language-porting. Java (`server/java/render/.../recover/` + `.../prompt/`) is the reference; the conformance corpus is the ORACLE (`fixtures/recover-conformance/`, `fixtures/conformance/template-output-{xml,json}-simple/`). Reimplement idiomatically (Tier-2); never change Tier-1 (classification, vocabulary, rendered output, wire format). Never edit a fixture to match the port — escalate a suspected-wrong fixture.

**Goal:** Bring FR-010 to the TypeScript port — the *reference* implementation, but FR-010's recover engine + output-format renderer don't exist in TS yet (Java was the pilot; C#/Kotlin followed). TS natively reimplements both in `@metaobjectsdev/render`, then adds the metamodel attrs + serializer fix + codegen, kept aligned to the shared corpora. After this, FR-010 ships in 4 ports (Java, Kotlin, C#, TS); only Python remains.

**Three phases (each a separate merge):**
1. **Recover engine + dirty-input conformance** — `packages/render/src/recover/*` reimplemented from the Java reference; a recover-conformance runner over `fixtures/recover-conformance/` is the correctness gate. (≈ Java Plan 1 / C# Phase 1.)
2. **OutputFormatRenderer** — `packages/render/src/prompt/*` (3 comment-free styles × {json,xml}); render parity, byte-identical to Java/Kotlin/C#. (≈ Java Plan 3 renderer / C# Phase 2.)
3. **Metamodel attrs + serializer fix + codegen + clean fixtures** — register `@promptStyle`/`@example`/`@instruction`/`@enumAlias`/`@enumDoc`; fix the canonical serializer to sort `properties`-attr map keys (NOT `filter`); extend `outputParser()` codegen with a tolerant `recover()`; add an output-prompt generator. (≈ Java Plans 2+3 codegen / C# Phase 3.)

**Tech stack:** TypeScript / Bun, ESM-only, `@metaobjectsdev/render` (+ `@metaobjectsdev/codegen-ts` in phase 3) + `@metaobjectsdev/metadata`. Zod is the FR-006 strict tier; recover is the new forgiving tier (no Zod). Reuse the existing `ESCAPERS` registry for the renderer. `bun test` per CLAUDE.md (`cd server/typescript && bun test`).

## Tier decisions (cross-language-porting)
- **Tier 1 (INVARIANT — must match the corpus):** per-field `FieldRecovery` classification (`RECOVERED|DEFAULTED|LOST_OPTIONAL|LOST_REQUIRED|MALFORMED`) + the `empty` flag + the canonical normalized value (numeric ±1e-9); the recover pipeline's observable behavior (strip/locate/forgiving-read/malformed-vs-absent/coerce); the rendered fragment (comment-free, valid, 3 styles); `@promptStyle`/`@enumAlias`/`@enumDoc` vocabulary; the MALFORMED/TRUNCATED sentinels' effect; the canonical serialization (`properties` keys sorted, `filter` order preserved).
- **Tier 2 (idiomatic TS):** module layout under `recover/`; `recover(text, schema, opts?)` free function returning a `RecoveryOutcome`; the generated `recover()` returns `RecoveryResult<{Name}Recovered>` where `{Name}Recovered` is an emitted interface with every field `T | null` (parallel to the C#/Kotlin nullable mirror — TS structural types make this a mapped/explicit interface, no `required`-keyword constraint, but the explicit mirror keeps cross-port symmetry and a clean public type). Enum members keep SCREAMING_SNAKE string values where serialized in `schema.json`/`expected.json` (corpus deserializes them).
- **Tier 3 (free):** internal mechanism, the conformance runner plumbing, the import-and-run proof harness.
- **Bounded deferral:** nested-object recover/prompt mapping; array-of-enum (parity with Java/Kotlin/C#).

---

## PHASE 1 — recover engine + dirty-input conformance (detailed)

Port the recover engine to `packages/render/src/recover/` idiomatically (TS modules, not classes-per-file where a module fits better), then prove against the corpus. **The corpus is the oracle: when a case is red, ask "should it match?" before "how do I make it match"; never edit a fixture.**

### T1-1: data model (`recover/types.ts`)
Port `Format`, `FieldKind`, `FieldRecovery`, `Tolerance`, `Coercion`, `FieldSpec` (+ factories `scalar`/`enumField`/`range`/`object`), `RecoverSchema`, `RecoverOptions` (+ `defaults()`), `RecoverOutcome`, `RecoveryResult`, `RecoveryReport` (mutable: `set`/`addCoercion`/`markEmpty`/`states`/`coercions`/`lostRequired`/`malformed`/`hasLostRequired`/`isEmpty`). Use string-union types for the enums (`as const`) with SCREAMING_SNAKE values matching the corpus. **Test:** mirror Java `ModelTest`/`ReportTest`.

### T1-2: `strip` (stage 1) — fence removal. Port `Strip.strip` (regex, dotall). Test mirrors `StripTest`.

### T1-3: `locate` (stages 2–3) — `locateJson(text)` balanced-brace (string-aware) + `locateXml(text, rootName, caseInsensitive)`; first-closed-else-first-open; the no-throw-on-`</x>` guard. Test mirrors `LocateTest`.

### T1-4: `json-forgiving-reader` — tolerant JSON → `Record<string, unknown>`; trailing commas, single/unquoted, **TRUNCATED sentinel**, no-hang on `{"xs":[}`. Port the FIXED Java version. Test mirrors `JsonForgivingReaderTest` (incl. no-hang + truncated-marks-sentinel).

### T1-5: `xml-forgiving-reader` — tolerant XML → map; unclosed-tag recovery, attr-quote variants, case-folding, no-throw on close-tag-start. Test mirrors `XmlForgivingReaderTest`.

### T1-6: `coerce` (stage 7) — enum alias/vocab (runtime-alias-wins), numeric range clamp, **non-finite → MALFORMED**, boolean forms, onField hook, normalizers. **TS numeric note:** use `Number(...)` + `Number.isFinite` (no locale issue in JS); match the finite-only + classification contract, NOT Java's suffix tolerance (documented divergence, same as C#). `MALFORMED` sentinel = a unique symbol/object. Test mirrors `CoerceTest`.

### T1-7: `recover` entry + `recover-map` + classify — assemble strip→locate→read→extract→classify→coerce; array partial-MALFORMED keeps elements; object-given-scalar → MALFORMED; TRUNCATED→MALFORMED; empty-guard. `recoverMap` accessors `asString/asInt/asLong/asDouble/asBool/asStringList` null-safe (TS: `asInt`/`asLong` both narrow `number`; JS has one number type — document that asInt/asLong both return `number | null` and truncate via `Math.trunc`). Test mirrors `RecoverTest`.

### T1-8: dirty-input conformance runner
Add a recover-conformance runner (in `packages/conformance` or `packages/render` test dir) walking `fixtures/recover-conformance/`: deserialize `schema.json` → RecoverSchema, read `input.txt`, run `recover`, assert `expected.json`'s `empty` + `states` (EXHAUSTIVE key-set) + `data` (doubles ±1e-9). All 10 cases must match.

### T1-9: review + simplify + merge
`bun test` green incl. corpus; final review + simplifier; `KNOWN_GAPS` note (nested deferral + numeric-suffix divergence). Merge phase 1.

---

## PHASE 2 — OutputFormatRenderer (outline; detailed when phase 1 lands)
Port `packages/render/src/prompt/{prompt-style,output-format-spec,prompt-field,prompt-overrides,output-format-renderer}.ts` — 3 comment-free styles (guide/inline/exampleOnly) × {json,xml}, reusing `ESCAPERS`. The rendered fragment is byte-identical to Java/Kotlin/C# (verbatim prose strings: "Fill in each field as described below:", "Respond exactly like this:", "    one of ", "      VAL = doc", "    e.g. "). Numeric-vs-quoted JSON uses `Number.isFinite` (NaN/Infinity → quoted). Tests mirror the Java renderer tests (comment-free, valid JSON via `JSON.parse`, the NaN-quoted + finite-unquoted cases).

## PHASE 3 — metamodel attrs + serializer fix + codegen (outline)
1. **Constants + attrs:** `@promptStyle` (closed enum guide|inline|exampleOnly on template.output — constants + `template-schema.ts` `allowedValues`, like `@format`); `@example`/`@instruction` (string, field common attrs); `@enumAlias`/`@enumDoc` (reuse `ATTR_SUBTYPE_PROPERTIES`). Add to `constants.ts`.
2. **Serializer fix:** in `serializer-json.ts`, sort `properties`-attr map keys ordinally while preserving `filter` order. The serializer is schema-free → distinguish by value shape (all-scalar values → sort; any object/array value → preserve), exactly as the C# port did. This closes the two `template-output-{json,xml}-simple` fixtures (currently red in TS — Java-authored expected.json sorts `@enumDoc`).
3. **Codegen:** extend `output-parser.ts`/`output-parser-file.ts` to emit a `recover{Name}(text, opts?)` returning `RecoveryResult<{Name}Recovered>` from a baked RecoverSchema (a `recoverSchemaEmitter`), alongside an emitted `{Name}Recovered` interface (all fields `| null`); a new output-prompt generator emitting a `render{Name}Format(overrides?)` backed by `OutputFormatRenderer` + an `outputFormatSpecEmitter`. Reuse the payload-codegen field map.
4. **Proof:** TS's advantage — write the emitted `.ts` to a temp module, `import()` it under bun, and CALL `recover{Name}()` on dirty input + `render{Name}Format()`, asserting the @enumAlias fold + the guide fragment. Plus `tsc` typecheck of the emitted source. This is a stronger proof than snapshot-only.
5. Clean `template-output-{json,xml}-simple` fixtures conformance (TS now green).

---

## Self-review (phase 1)
- All recover modules ported; corpus 10/10 green (the oracle); classification + canonical-value asserted (not raw bytes); FIXED Java behaviors carried (no-hang JSON, XML no-throw, non-finite MALFORMED, TRUNCATED→MALFORMED, array partial); never-throws; nested deferred.
- Verify-against-live-code: the TS attr-read API (`md.attr(...)` / effective children), the bun test idiom, the `ESCAPERS` API (phase 2), the conformance fixture-walk + canonical-serialize comparison (phase 3), the import-and-run proof under bun.
