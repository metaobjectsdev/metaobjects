# FR-010 — Output-format prompt generation + tolerant parsing (cross-port design)

**Status:** Design — **open questions resolved 2026-05-29** (see *Resolved decisions* and the *Open questions* section). Ready for the per-port implementation plan.
**Date:** 2026-05-29
**Scope:** Cross-port parent design (render pillar). Per-port implementation FRs follow once the shape is agreed.
**Pilot port:** **Java** — the first real adopter is a Java consumer, so the pilot dogfoods the hard tolerance work against real dirty output, and the shared JVM `render` module means Kotlin inherits the `recover` engine next at low cost. (This supersedes the original "TypeScript first" rollout premise, which is partly stale: all five ports already ship the FR-006 strict parser + payload-VO codegen.)

## Resolved decisions (2026-05-29)

A planning pass (prior-art survey of tolerant LLM-output parsers + a codebase audit) settled the shape:

- **Cross-port tolerance is pinned at *classification + canonical value*, not byte-identity.** The per-field recovery *classification* (the state enum below) is the byte-identical cross-port invariant and the conformance anchor; the canonical normalized value is pinned; raw numeric coercion (float rounding, etc.) carries a *documented tolerance*, not byte-equality. Byte-identical coercion across five native runtimes is costly-to-impossible (float/locale/Unicode divergence) and is the one thing BAML-style consistency only buys via a single compiled core + FFI — which would break this project's zero-runtime-dependency / AOT-friendly / idiomatic-native contract. This project already keeps loader/serializer/render/persistence consistent via native-per-port + conformance corpora; `recover` follows suit, gating *classification* rather than bytes.
- **Intra-port architecture: thin codegen + one shared `recover()` engine per port** (a small generated field-descriptor; the engine runs the pipeline), *not* the pipeline inlined into every emitted file. One tolerance implementation per port is the only way to keep the dirty corpus honest. Two refinements borrowed from the survey: split stage 1 into **strip → locate → score/select** (ambiguous-candidate selection is where determinism matters most, and must be deterministic across ports), and treat the report as an **escalation contract** a consumer may act on (the engine never re-prompts).
- **Field-teaching attributes are discrete, reusing existing metamodel machinery.** `@example` / `@instruction` are plain `string` attrs; `@enumDoc` (member→description) and `@enumAlias` (off-vocab→canonical) use the **existing `properties` attr subtype** (map-shaped, already present and canonical-serialized in all five ports) — no new attr value-kind, no five-port loader surgery. The vocabulary registration is cross-port (so the shared clean fixtures load everywhere); only the pilot port emits the new artifacts initially.
**Depends on:**
- [FR-004](./2026-05-22-fr-004-cross-language-prompt-construction-design.md) — `template.prompt` payload-VO codegen + render handles (the *input*-side symmetry).
- [FR-006](./2026-05-25-fr6-template-output-parser-codegen.md) + [ADR-0010](../../../spec/decisions/ADR-0010-template-output-parser-codegen.md) — `template.output` parse-on-receipt codegen (the strict parser this FR extends).

## Goal

Make a single `template.output` declaration drive **three** artifacts instead of one:

1. **The output-format *prompt fragment*** — the section of the prompt that instructs the model *how to produce* the result payload (the "fill in your answer like this" block: a skeleton in the declared format plus per-field guidance). This is the symmetric twin of FR-004's input-side render handle, and is entirely new — FR-006 parses but emits no prompt text.
2. **A tolerant parser** — a recovery-oriented reader that assumes the model will *not* return clean output (prose around the payload, code fences, reasoning preambles, unclosed tags, wrong casing, omitted optional blocks, out-of-range or off-vocabulary values) and extracts the best-effort typed payload plus a structured recovery report. This extends FR-006's strict `parse`/`safeParse` with a third tier.
3. **First-class XML *and* JSON** for both of the above, selected by a `format` attribute on the `template.output` node.

All three are **cross-port** (TypeScript, C#, Python, Java, Kotlin), consistent with FR-006's staggered rollout and the polyglot principle.

```ts
// Consumer side, after FR-010 (TS shape, illustrative)
import { renderAnswerFormat } from "./generated/Answer.outputPrompt";  // NEW (artifact 1)
import { recoverAnswer, parseAnswer } from "./generated/Answer.output"; // recover NEW (artifact 2)

const prompt = basePrompt + renderAnswerFormat();          // appends the "produce it like this" section
const raw = await llm.call(prompt);                        // model returns who-knows-what

const { data, report } = recoverAnswer(raw);               // best-effort; never throws
if (report.lostRequired.length) retryOrEscalate(report);   // structured, field-level recovery info
else use(data);
// parseAnswer(raw) (FR-006) still available when strict enforcement is wanted
```

## Why

### The output contract drifts because it lives in three hand-maintained places

A prompt that asks for structured output has, today, three independent hand-written surfaces:

- **the prompt prose** that describes the format ("emit `<answer>` with a `<confidence>` of HIGH|OK|LOW…"),
- **the parser** that reads the response back into typed data, and
- **the validation/retry** that decides whether a response is acceptable.

When two surfaces describe the same structure, their free-form parts diverge silently — a field renamed in the parser but not the prompt, an enum value the prompt teaches but the parser rejects. FR-006 collapsed *parser* and *validator* onto the `@payloadRef` value-object. FR-010 brings the **prompt prose** onto the same source, so all three derive from one declaration and `meta verify` can fail the build on drift.

### FR-006 is strict and JSON-leaning; real model output is neither

FR-006's generated parsers lean on each port's native validation library (Zod, Pydantic, Jackson, System.Text.Json). Those are excellent at *rejecting* malformed input and assume a clean JSON document. Production LLM output, across providers and models, routinely is not clean:

- the payload is wrapped in conversational prose ("Sure! Here's the result: …") or markdown code fences;
- a reasoning/thinking preamble precedes it;
- tags are unclosed, mis-cased, or have stray whitespace/attribute-quoting variants;
- optional blocks are omitted entirely;
- values are off-vocabulary ("warm" where the enum is `FRIENDLY`) or out of range;
- the format requested was XML, not JSON, because the payload is a mix of prose and structure that XML expresses more naturally.

A strict native validator turns every one of these into a hard failure, pushing all recovery logic back onto the adopter — exactly the boilerplate the codegen exists to remove. FR-010 adds a tolerance layer so the common, recoverable cases yield a usable payload + a report, and only genuinely-unrecoverable responses fail.

### XML is a first-class output format, not an afterthought

For payloads that interleave authored prose with structure, XML-style tagging is often easier for a model to produce reliably than deeply-nested JSON, and easier to recover from when malformed (a missing close-tag is locally repairable; a missing JSON brace corrupts the whole document). The render pillar already carries a `format` attribute on `template.prompt`; FR-010 makes `format: xml | json` meaningful on `template.output` for both the generated prompt fragment and the parser.

## Design

### `template.output` gains a `format` attribute

```yaml
- name: answerOutput
  type: template.output
  attrs:
    payloadRef: Answer          # the output value-object (FR-006 semantics, unchanged)
    format: xml                 # xml | json  (NEW; default json for back-compat with FR-006)
```

`format` selects the shape of both generated artifacts. No new `@outputRef` attribute — `@payloadRef` on a `template.output` already points at the output VO (ADR-0010 / FR-006).

### Artifact 1 — the output-format prompt-fragment generator

A new stock generator (sibling to FR-004's render-handle / the `promptRender()` factory) walks each `template.output` + its `@payloadRef` VO and emits a render function that produces the **format-instruction section** of the prompt:

- a **skeleton** in the declared format — an XML tag tree or JSON object with placeholder/example values,
- per-field **guidance**: allowed-value enumerations, required-vs-optional marking, and any authored teaching attached to the field.

**Critical design constraint — the prompt fragment is pedagogy, not a schema dump.** A bare structural rendering ("`<confidence>string</confidence>`") underperforms with smaller/instruction-tuned models, which copy *examples* far more reliably than they follow *rules*. The schema node must therefore be able to carry, per field, hand-authored:

- an **example value** (and optionally a counter-example / "wrong vs right" pair),
- an **enum with per-value descriptions**,
- a short **instruction** string.

These ride as field-level attributes on the VO and the generator weaves them into the rendered section. **(Resolved 2026-05-29.)** `@example` / `@instruction` are plain `string` attrs; `@enumDoc` / `@enumAlias` reuse the existing `properties` (map) attr subtype — discrete attrs, greppable and individually `verify`-able, consistent with `@currency` / `@values` / `@maxLength`. The schema owns *structure + the required-output contract*; humans still own the *examples*. A generated fragment must never erode an adopter's ability to hand-tune the example for a specific model — that tuning is frequently the load-bearing part of compliance.

Because the *right* example often varies by runtime context (a different target model, a domain variant), the schema `@example` is the **canonical default**, and the generated render function accepts a **render-time override**: `renderXxxFormat({ examples?, instructions? })`. No schema edit, no code fork, to swap the worked example per call site. (See Extensibility below.)

**Static structure, dynamic gating.** The fragment's *shape* is codegen-time; runtime conditionals (a feature toggle that omits a block, per-request injected fields) stay render-time, expressed as template sections gated on input-payload booleans — identical to the FR-004 input side. The generator emits the skeleton; conditionals are not codegen's concern.

**Guidance carrier — never comments (resolved 2026-05-29).** The per-field guidance must NOT live in comments. Many models (e.g. Nemotron) ignore XML `<!-- -->`, and JSON has no comment syntax at all — a `//`-annotated "JSON" skeleton is not even valid JSON. Guidance hidden in comments is guidance the model is free to ignore, defeating the pedagogy goal. The robust carriers are a **prose field-guide** preceding a **clean, valid, example-filled skeleton**, and/or allowed values shown as element/field **content** (not comments).

**Presentation is a metadata attribute — `@promptStyle` (resolved 2026-05-29).** How the fragment is laid out is a closed-enum attribute on `template.output`, sibling to `@format`, with `allowedValues` `guide | inline | exampleOnly` (default `guide`):
- `guide` — prose field-guide (allowed values + `@enumDoc` meanings, required/optional, `@instruction`, `@example`) above a clean valid example-filled skeleton. The robust default.
- `inline` — allowed values as element/field content (`HIGH | MEDIUM | LOW`), placeholders as content, minimal prose. Terser; content (unlike comments) is attended to.
- `exampleOnly` — just the example-filled skeleton (for few-shot contexts where guidance lives elsewhere).

Putting the directive on the durable spine (not just a render-time flag) means project-wide consistency comes for free via the existing **abstract + `extends`** mechanism: declare an `abstract: true` `template.output` base carrying `@format` + `@promptStyle`, and every concrete output `extends` it — flip the whole project's presentation in one edit. (`extends` resolution merges attrs, child wins, so any single output can override.) A **render-time override** still rides on top for per-call/per-model tuning: `renderXxxFormat({ style?, examples?, instructions? })` — the two-channel model (schema default + one opts bag) from Extensibility. (Open: whether the loader enforces `@payloadRef`/`@textRef` *required* on an `abstract` base that carries only directives; abstracts that omit them rely on required-validation applying to concrete nodes post-`extends`.)

### Artifact 2 — tolerant ("recover") parsing tier

FR-006 defines two tiers per port: `parse` (throws) and `safeParse`/`TryParse` (Result/bool). FR-010 adds a third, **`recover`**, whose contract is *best-effort, never throws, always returns a report*:

```
recoverXxx(text, opts?) -> { data: Partial<Xxx>, report: RecoveryReport }
```

`opts` is optional — `recoverXxx(text)` with no arguments is the zero-config 80% case. The bounded override surface is defined in Extensibility below. The generated `recover` runs a pipeline of format-agnostic stages before (and instead of failing at) the strict validator:

1. **Locate** — find the payload within surrounding text. Strip markdown code fences, leading/trailing conversational prose, and reasoning/thinking preambles; isolate the outermost declared root (the `<root>…</root>` span or the first balanced `{…}`). A response that buries the payload in chatter still parses.
2. **Forgiving structural read** — newline- and whitespace-tolerant; tolerant of attribute-quoting variants; optionally case-insensitive tag/key matching. For XML, recover inner content of a tag that opened but did not cleanly close (locally repairable); for JSON, tolerate trailing commas and single quotes where unambiguous.
3. **Per-field optional + default** — a missing *optional* field yields its default and is noted, not failed. Extraction is **partial**: every field that *can* be read *is* read, independent of its siblings. No all-or-nothing.
4. **Malformed-but-present detection** — distinguish "field absent" from "field present but garbled." A garbled-but-present required field is a different, louder signal than a clean omission (the model tried and failed vs. ignored the instruction) — both surface in the report with that distinction.
5. **Normalize / coerce** — apply per-field canonicalization: an alias map folds off-vocabulary values onto the declared enum (`@enumAlias`); numeric/range fields coerce or clamp to the declared bounds rather than reject. Coercions are recorded.
6. **Report** — `RecoveryReport` enumerates, per field: `recovered` (with the coercion/normalization applied, if any), `defaulted`, `lostOptional`, `lostRequired`, `malformed`. Adopters branch on `lostRequired`/`malformed` to retry, escalate, or accept. An **empty/degenerate response** (whitespace-only, no recognizable root) is its own first-class report state, not a generic parse error.

The strict `parse`/`safeParse` tier is unchanged — `recover` is additive. Adopters choose enforcement (`parse`) vs resilience (`recover`) per call site.

**Implementation shape (resolved 2026-05-29).** The pipeline is *not* inlined per emitted file. Codegen emits a thin per-template **field descriptor**; a single shared **`recover()` engine** (in the JVM `render` module for the Java/Kotlin ports; the sibling runtime module per other port) executes the stages against that descriptor. Stage 1 is split into **strip** (fences / prose / preamble / JSONP / NDJSON) → **locate** (isolate the candidate root span) → **score/select** (deterministically pick among ambiguous candidates against the schema — this selection ordering is part of the cross-port classification contract). The engine never re-prompts; the `RecoveryReport` is an **escalation contract** the consumer may branch on. Java's `recover` returns a `RecoveryResult<T>` record (data + report) and never throws — distinct from FR-006's throw-only `parse`.

### XML/JSON symmetry

Both artifacts are emitted for whichever `format` the node declares:

| | `format: json` | `format: xml` |
|---|---|---|
| Prompt skeleton | example JSON object | example tag tree |
| Locate stage | strip fences/prose → first balanced object | strip fences/prose → outermost root span |
| Forgiving read | trailing commas, single quotes | unclosed-tag inner recovery, attr-quote variants |
| Strict tier (FR-006) | native JSON validator | native XML/tag validator |

A VO whose fields carry authored prose (long free-text) is a signal the adopter likely wants `xml`; a flat data record signals `json`. The generator does not choose — the adopter declares `format`.

### `meta verify` extension

FR-006 already extends `meta verify` to walk `template.output` and check parser-schema field names against the `@payloadRef` VO (`kind: "output"` findings). FR-010 adds:

- **Prompt-fragment coverage** — every required output field/anchor named in the VO must appear in the generated output-format fragment (symmetric with the existing `@requiredTags` output-anchor check), `kind: "output-prompt"`.
- **Round-trip check** — the skeleton emitted by artifact 1 must `recover` (artifact 2) back to a structurally-complete payload. This catches a prompt fragment and parser that have silently diverged in the *format* dimension (e.g. fragment teaches an attribute the parser drops). Build-time, no model call.

## Extensibility for downstream adopters (the 80/20 boundary)

Downstream apps *will* need looser parsing and specialized examples the framework can't anticipate. The design admits that — but draws a hard line so it doesn't become a plugin framework.

**Cardinal rule: generated artifacts are never hand-edited.** All customization enters through exactly two channels — (a) **schema attributes** (compile-time defaults that travel with the model) and (b) **one optional `opts` argument** on each generated function (runtime overrides). Generated files stay a black box, so regeneration is always safe.

**The 80% — zero config.** `renderXxxFormat()` and `recoverXxx(text)` take no arguments and handle the common case: schema-declared examples/enums/aliases and the standard six-stage recovery. Most call sites never pass `opts`.

**The 20% — three bounded escape hatches, and only three:**

1. **Render-time style / example / instruction override** — `renderXxxFormat({ style?, examples?, instructions? })`. Per-call override of the canonical `@promptStyle` / `@example` / `@instruction` when presentation or the worked example must vary by runtime context (target model, domain variant). The single-source defaults still live in the schema (and project-wide via an abstract `extends` base); this overrides per call. `style` ∈ `guide | inline | exampleOnly`.
2. **Per-field normalizer / alias extension** — `recoverXxx(text, { aliases?, normalizers? })`. Adopter-supplied alias entries and per-field normalize functions are **merged with** (never replace) the schema-declared ones — app-specific off-vocabulary folding the framework can't know about.
3. **Tolerance level + one coercion hook** — `recoverXxx(text, { tolerance?: 'strict' | 'normal' | 'loose', onField? })`. Three presets span the spectrum (`strict` ≈ FR-006 `parse`; `normal` = default; `loose` = maximally forgiving locate/repair). `onField(name, rawValue, ctx)` is a single optional callback for the rare bespoke coercion. That is the **entire** runtime surface — one knob and one hook, deliberately not a registry of pluggable stages.

**Deliberately NOT provided — to keep it from getting complicated:**

- **No pluggable/replaceable stage pipeline; no subclassable generated parsers.** If an adopter needs more than the hatches above, the pattern is **compose, don't extend**: wrap the generated `recoverXxx` in your own function — pre-process the text, call `recover`, post-process the `report`. The generated parser is a *building block*, not a base class. This costs the adopter a few lines and costs the framework nothing.
- **No runtime structure/grammar injection.** Runtime `opts` override *values* (examples, aliases, tolerance) — never the *shape*. The schema remains the single source of structure, so `meta verify` and the round-trip check stay meaningful.

This boundary *is* the 80/20 line: schema attributes + one `opts` bag cover the overwhelming majority; everything past it is ordinary composition in adopter code, which needs no framework support and adds no framework complexity. The `opts` shape (and the `RecoveryReport`) are part of the cross-port contract — idiomatic per port, identical in meaning.

## Per-port rollout

All five ports already ship the FR-006 strict parser + payload-VO codegen, so rollout is gated by adopter pull and shared-module reuse rather than codegen-layer readiness:

| Port | Order | Notes |
|---|---|---|
| **Java** | **Pilot** | First implementation — real Java adopter dogfoods tolerance. `recoverXxx` returns a `RecoveryResult<T>` record; `recover` engine lands in the shared JVM `render` module. Artifact 1 (prompt-fragment generator) is greenfield on the JVM (render is runtime-only there today). |
| **Kotlin** | Next | Inherits the `recover` engine from the shared JVM `render` module at low cost; `recoverXxx` returns a sealed result alongside its existing dual-API parser. |
| **C#** | After JVM | `TryRecover` idiom alongside `TryParse`. |
| **Python** | After JVM | `recover_xxx` returning `(data, report)`. |
| **TypeScript** | After JVM | Most mature codegen siblings (`outputParser` + `promptRender` both exist to extend); dual API `recoverXxx(text, opts?) -> { data, report }`. |

Each per-port FR is a self-contained implementation spec; the cross-port contract here (three artifacts, `format`, the six-stage recover pipeline, the report shape) holds across all of them.

## Cross-port testing strategy

- **Conformance fixtures (clean).** Extend the shared corpus with `template-output-xml-simple/` and `template-output-json-simple/`, each shipping `expected/` for the generated prompt fragment *and* the parser, so the codegen contract is documented as data.
- **"Dirty input" corpus (the differentiator).** A shared set of *deliberately malformed* model responses per fixture — fenced, prose-wrapped, preamble-prefixed, unclosed-tag, mis-cased, optional-omitted, off-vocabulary, out-of-range, truncated-JSON, empty — with the expected `{data, report}` for each. Every port's `recover` runs the same dirty corpus. **The conformance assertion is on the recovery *classification* (the per-field state enum) and the *canonical normalized value* — these must be byte-identical across ports.** Raw numeric coercion carries a *documented tolerance* (float/locale/Unicode parsing legitimately diverges across native runtimes), so the corpus pins the canonical form, not the raw coerced bytes. This is the FR's correctness anchor: tolerance is meaningful only if its *classification* is identical and predictable across ports.
- **Round-trip property test.** For each fixture: `recover(renderSkeleton())` is structurally complete with an empty `lostRequired`.

## Out of scope (candidate follow-ons)

- **Provider-side structured-output artifacts** (OpenAI `response_format`, Anthropic tool schemas) derived from the same VO — a natural sibling FR, but distinct from prompt-fragment generation.
- **A combined render→call→recover workflow handle.** The call layer (provider, streaming, retries) is the adopter's; codegen stays on either side of it (FR-006 ADR-0010 rationale).
- **Automatic retry/repair loops.** `recover` *reports*; it does not re-prompt. Retry policy is the adopter's.
- **Schema-inferred examples.** Examples are hand-authored (`@example`); generating plausible examples from types is explicitly not attempted (it would regress the pedagogy constraint).

## Open questions — all resolved 2026-05-29

1. **Field-teaching attribute surface.** ✅ **Discrete attrs.** `@example` / `@instruction` are plain `string` attrs; `@enumDoc` / `@enumAlias` use the existing `properties` (map) attr subtype. Greppable, diff-friendly, individually `verify`-able, and reuses metamodel machinery already present in all five ports (no new attr value-kind). The `@io`-block alternative was rejected as harder to verify/diff field-by-field.
2. **Alias conflict (schema `@enumAlias` vs runtime `{ aliases }`).** ✅ **Runtime wins, recorded in the report.** Schema `@enumAlias` is the canonical default (travels with the model, usable by the strict tier); adopter-merged runtime aliases override on key collision and the override is noted in the `RecoveryReport`.
3. **Case-insensitivity default.** ✅ **Folded into the `tolerance` preset — not a separate knob.** `strict` = case-sensitive tag/key matching (≈ FR-006 `parse`); `normal` (default) and `loose` = case-insensitive. Keeps the runtime override surface to the single bounded `opts` bag.
4. **`recover` for `format: json` and partial documents.** ✅ **Bounded prefix recovery.** Repair unclosed braces/strings, extract every top-level key that fully parsed, mark the truncation-point field `malformed` and any still-missing required fields `lostRequired`; nested-truncation is best-effort. Behavior pinned exactly in the dirty corpus.
5. **Report stability across ports.** ✅ **Frozen now and conformance-pinned.** The per-field state enum is `recovered` / `defaulted` / `lostOptional` / `lostRequired` / `malformed`, plus `empty` as the first-class degenerate-response state. This enum (the *classification*) — not raw byte coercion — is the cross-port contract; see *Resolved decisions* and *Cross-port testing strategy*.

## Note on provenance

The tolerance taxonomy in this FR (locate-then-extract, fenced/preamble stripping, partial extraction with per-field defaults, malformed-vs-absent distinction, canonical-value/alias normalization, range coercion, empty-response guard) generalizes patterns that recur in production LLM-output consumers. It is framework-level and adopter-agnostic by design; no specific adopter's domain vocabulary appears here.
