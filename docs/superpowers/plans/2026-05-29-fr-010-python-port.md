# FR-010 Python port — native recover engine + output-format renderer + codegen

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development + cross-language-porting. Java (`server/java/render/.../recover/` + `.../prompt/`) is the reference; C# (`server/csharp/MetaObjects.Render/{Recover,Prompt}/` + `MetaObjects.Codegen/Generators/`) and TS are fresh native ports to mirror. The conformance corpus is the ORACLE (`fixtures/recover-conformance/`, `fixtures/conformance/template-output-{xml,json}-simple/`). Reimplement idiomatically (Tier-2); never change Tier-1 (classification, vocabulary, rendered output, wire format). Never edit a fixture to match the port — escalate.

**Goal:** Bring FR-010 to the Python port — the LAST of the five ports. Python ships FR-006 + render + verify + codegen + conformance, but FR-010's recover engine + output-format renderer don't exist yet. Python natively reimplements both under `metaobjects/render/`, then adds the metamodel attrs + serializer fix + codegen. After this, FR-010 ships in all 5 ports.

**Three phases (each a separate merge):**
1. **Recover engine + dirty-input conformance** — `metaobjects/render/recover/` reimplemented from Java/C#; a recover-conformance pytest over `fixtures/recover-conformance/` is the gate. (≈ C# Phase 1.)
2. **Output-format renderer** — `metaobjects/render/prompt/` (3 comment-free styles × {json,xml}); byte-identical to Java/Kotlin/C#/TS, reusing the `escapers` registry. (≈ C# Phase 2.)
3. **Metamodel attrs + serializer fix + codegen + clean fixtures** — register `@promptStyle`/`@example`/`@instruction`/`@enumAlias`/`@enumDoc`; fix `serializer_json` to sort `properties`-attr map keys (NOT `filter`); extend the output-parser codegen with a tolerant `recover_<name>()`; add an output-prompt generator. (≈ C# Phase 3.)

**Tech stack:** Python 3.11+, `metaobjects` package at `server/python/`, pytest, mypy --strict, ruff. Pydantic is the FR-006 strict tier; recover is the new forgiving tier (no Pydantic). Reuse the `metaobjects.render.escapers` registry for the renderer. Tests under `server/python/tests/`.

## Tier decisions (cross-language-porting)
- **Tier 1 (INVARIANT — must match the corpus):** per-field `FieldRecovery` classification (`RECOVERED|DEFAULTED|LOST_OPTIONAL|LOST_REQUIRED|MALFORMED`) + `empty` flag + canonical normalized value (numeric ±1e-9); pipeline behavior (strip/locate/forgiving-read/malformed-vs-absent/coerce); the rendered fragment (comment-free, valid, 3 styles); `@promptStyle`/`@enumAlias`/`@enumDoc` vocabulary; MALFORMED/TRUNCATED sentinel effect; canonical serialization (`properties` keys sorted, `filter` order preserved).
- **Tier 2 (idiomatic Python):** module layout under `recover/`; `recover(text, schema, opts=None)` free function; enums via `enum.Enum`/`StrEnum` with SCREAMING_SNAKE values matching the corpus; MALFORMED/TRUNCATED as unique sentinel objects; the generated `recover_<name>()` returns `RecoveryResult[<Name>Recovered]` where `<Name>Recovered` is an emitted dataclass with every field `Optional[T]` (parallel to C#/Kotlin/TS nullable mirror — Pydantic payloads can't hold None for a required field). `as_int`/`as_long` both return `Optional[int]` (Python has one int type).
- **Tier 3 (free):** internal mechanism, the conformance runner plumbing, the import-and-call proof.
- **Bounded deferral:** nested-object recover/prompt mapping; array-of-enum (parity with the other ports — though TS implemented engine-level nested; Python may either way as long as the corpus + codegen defer).

---

## PHASE 1 — recover engine + dirty-input conformance (detailed)

Port the engine to `metaobjects/render/recover/` (Python modules), then prove against the corpus. **The corpus is the oracle: when a case is red, ask "should it match?" before "how do I make it match"; never edit a fixture.**

### P1-1: data model (`recover/types.py`)
Port `Format`, `FieldKind`, `FieldRecovery`, `Tolerance`, `Coercion`, `FieldSpec` (+ factories `scalar`/`enum_field`/`range_`/`object_`), `RecoverSchema`, `RecoverOptions` (+ `defaults()`), `RecoverOutcome`, `RecoveryResult`, `RecoveryReport` (mutable: `set`/`add_coercion`/`mark_empty`/`states`/`coercions`/`lost_required`/`malformed`/`has_lost_required`/`is_empty`). Enums with SCREAMING_SNAKE values matching the corpus. **Test:** mirror Java `ModelTest`/`ReportTest`.

### P1-2: `strip` (stage 1) — fence removal (regex, DOTALL). Mirror `StripTest`.
### P1-3: `locate` (stages 2–3) — `locate_json` balanced-brace (string-aware) + `locate_xml`; first-closed-else-first-open; no-throw-on-`</x>`. Mirror `LocateTest`.
### P1-4: `json_forgiving_reader` — tolerant JSON → dict; trailing commas, single/unquoted, **TRUNCATED sentinel**, no-hang on `{"xs":[}`. Port the FIXED version. Mirror `JsonForgivingReaderTest`.
### P1-5: `xml_forgiving_reader` — tolerant XML → dict; unclosed-tag recovery, attr-quote variants, case-folding, no-throw on close-tag-start. Mirror `XmlForgivingReaderTest`.
### P1-6: `coerce` (stage 7) — enum alias/vocab (runtime-alias-wins), numeric range clamp, **non-finite → MALFORMED**, boolean forms, on_field hook, normalizers. **Python numeric note:** use `float(...)`/`int(...)` with `math.isfinite`; reject `0x`/`0b`/`0o` radix prefixes that `int(s,0)` would accept but Java/C# reject (cross-port parity — both C# and TS added this guard); empty-string guard. `MALFORMED` = a unique sentinel object. Mirror `CoerceTest`.
### P1-7: `recover` entry + `recover_map` + classify — assemble strip→locate→read→extract→classify→coerce; array partial-MALFORMED keeps elements; object-given-scalar → MALFORMED; TRUNCATED→MALFORMED; empty-guard. `recover_map` accessors `as_string/as_int/as_long/as_double/as_bool/as_string_list` None-safe. Mirror `RecoverTest`.
### P1-8: dirty-input conformance runner
`tests/conformance/test_recover_conformance.py` (parametrized over `fixtures/recover-conformance/`): parse `schema.json` (map UPPER enum strings), read `input.txt`, run `recover`, assert `expected.json`'s `empty` + `states` (EXHAUSTIVE key-set) + `data` (floats ±1e-9). All 10 cases.
### P1-9: review + simplify + merge. `pytest` + `mypy --strict` + `ruff` green; KNOWN_GAPS note. Merge phase 1.

---

## PHASE 2 — output-format renderer (outline; detailed when phase 1 lands)
Port `metaobjects/render/prompt/{prompt_style,prompt_field,output_format_spec,prompt_overrides,output_format_renderer}.py` — 3 comment-free styles × {json,xml}, reusing `escapers`. Byte-identical fragment (verbatim prose: "Fill in each field as described below:", "Respond exactly like this:", "    one of ", "      VAL = doc", "    e.g. "). Numeric-vs-quoted uses `math.isfinite` + the radix guard (NaN/Infinity/0x.. → quoted). Tests mirror the Java renderer tests (comment-free, valid JSON via `json.loads`, NaN-quoted + finite-unquoted).

## PHASE 3 — metamodel attrs + serializer fix + codegen (outline)
1. **Attrs:** `@promptStyle` (closed enum on template.output via a `_TEMPLATE_OUTPUT_ATTRS` AttrSchema with `allowed_values`, like `@format`); `@example`/`@instruction` (string, common field attrs); `@enumAlias`/`@enumDoc` (`ATTR_SUBTYPE_PROPERTIES`). Add constants.
2. **Serializer fix:** in `serializer_json._normalize` (or the attr-value emit), sort `properties`-attr map keys ordinally while preserving `filter` order — value-shape heuristic (all-scalar values → sort; any dict/list value → preserve), same as C#/TS. Confirm filter desugar runs before serialization. Closes `template-output-{json,xml}-simple` (red in Python today).
3. **Codegen:** extend the output-parser generator to additionally emit a `<Name>Recovered` dataclass (all `Optional`) + `recover_<name>(text, opts=None) -> RecoveryResult[<Name>Recovered]` from a baked RecoverSchema (a recover-schema emitter), for json/xml outputs; a new output-prompt generator emitting `render_<name>_format(overrides=None)` backed by the output-format renderer + an output-format-spec emitter. Reuse `type_map.py`.
4. **Proof:** Python's advantage — `importlib` the emitted module in a test and CALL `recover_<name>()` on dirty input (@enumAlias fold) + `render_<name>_format()` (guide fragment). Plus mypy on emitted source if feasible.
5. Clean `template-output-{json,xml}-simple` fixtures conformance (Python green).

---

## Self-review (phase 1)
- All recover modules ported; corpus 10/10 green; classification + canonical-value asserted; FIXED behaviors carried (no-hang JSON, XML no-throw, non-finite MALFORMED, TRUNCATED→MALFORMED, radix-prefix guard, array partial); never-throws; nested deferred.
- Verify-against-live-code: the Python attr-read API, the pytest parametrize idiom, the `escapers` registry (phase 2), the conformance fixture-walk + canonical-serialize compare (phase 3), the importlib proof.
