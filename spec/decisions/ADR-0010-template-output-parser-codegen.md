# ADR-0010 — Per-port parser-on-receipt codegen for `template.output`

**Status:** Accepted — 2026-05-25
**Applies to:** all language ports (TS, Java, Python, C#)
**Related:** `docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md` (the cross-port design FR); per-port FRs (`fr6-ts`, `fr6-csharp`, `fr6-python`, `fr6-java`); FR-004 design (`2026-05-22-fr-004-cross-language-prompt-construction-design.md`); ADR-0001 (cross-language metadata→native-type binding); ADR-0008 (param-passing generated repo helpers — companion family pattern).

## Context

The `template.*` metatype has two concrete subtypes. `template.prompt` ships
codegen — `generateRenderHandle()` + `generatePayloadInterfaces()` emit a typed renderer
that takes a payload and produces text. `template.output` is declared in the metamodel
but the existing render handle treats it as just-another-template producing text — there
is no first-class **structured-output parser** for adopters who want typed data back from
LLM responses.

The 80% case for `template.output` is: an LLM produces text (whether enforced by a
provider's structured-output mode or not), the consumer's code receives it, and needs
to extract typed data conforming to the declared `@payloadRef` shape. Defensive parsing
on receipt is what every consumer's code does — independent of which provider it talks
to and whether that provider's structured-output mode is enabled.

Two coupled design decisions:

**(1)** What does codegen for `template.output` actually emit?

**(2)** What is the cross-language API contract — uniform across ports, or per-port
idiomatic?

## Decision

### (1) Codegen emits a **typed parser-on-receipt**

For each `template.output` declaration, codegen emits a parser function (or pair of
functions, per port idiom) that:

- Takes the raw LLM response text as input.
- Validates it against the schema derived from the `template.output`'s
  `@payloadRef` value-object.
- Returns a typed payload (or a structured failure).

**What codegen does NOT emit in this scope:**

- **Provider-side schema artifacts** (OpenAI `response_format`, Anthropic tool
  definitions, Gemini schemas). Each provider has its own format; emitting one
  blesses a provider, emitting all multiplies surface. Adopters that want
  provider-side enforcement can derive it from the same `@payloadRef` shape themselves
  (or via a future FR if demand surfaces).
- **A combined "workflow" handle** (render-prompt → call-LLM → parse-output). The
  LLM-call layer varies wildly across adopters (provider, model, streaming, retries,
  fallback chains). Codegen does not get into the LLM-call business. The consumer
  composes the generated render handle (from `template.prompt`) with the generated
  parser (from `template.output`) and their own LLM-call layer.

### (2) **Per-port idiomatic emission**, **discoverability-uniform documentation**

The cross-port contract is NOT a single API shape (e.g. one Result<T> type that every
port must emit). It is a **soft contract on discoverability**:

- Every port emits a parser-on-receipt for `template.output`.
- Every port's generated parser carries an explicit failure-mode declaration in its
  docstring / JSDoc / XML doc — an adopter reading the generated code in any port
  knows what to expect without guessing.
- The emitted API shape follows each port's ecosystem conventions:

| Port | Emitted API shape | Failure idiom |
|---|---|---|
| **TypeScript** | Dual API: `parseXxx(text): T` (throws) + `safeParseXxx(text): { success: true; data: T } \| { success: false; error: ValidationError }` | Throws Zod `ZodError` on `parse`; returns Result-shape on `safeParse`. Matches Zod and the Vercel AI SDK (`generateObject` + `safeGenerateObject`). |
| **C#** | Dual API: `ParseXxx(string text)` (throws) + `TryParseXxx(string text, out Xxx result, out Error error)` (Result-style boolean) | Throws `JsonException` on `Parse`; returns `bool` on `TryParse`. Matches .NET BCL `Parse`/`TryParse` long-standing convention. |
| **Python** | Single API: `parse_xxx(text: str) -> Xxx` | Raises Pydantic `ValidationError` (or wrapper). Matches Pydantic v2, Instructor, LangChain structured-output conventions — Python LLM ecosystem is uniformly exception-based. |
| **Java** | Single API: `parseXxx(String text)` | Throws `JsonProcessingException` or `XxxValidationException`. Matches Jackson and the Java ecosystem norm. |

**Rationale for not forcing a uniform shape:**

The TypeScript and C# ecosystems independently converged on dual APIs (one
throwing, one Result-style). The Python and Java ecosystems independently converged
on exception-based parsing. Forcing one shape across all four ports either ties TS's
hands (no Result-style for edge contexts where exception control flow is more
expensive) or imposes a Result-style on Python and Java where it's non-idiomatic
(`safe_parse_xxx` in Python looks foreign; `TryParseXxx` in Java has no idiomatic
precedent).

The cross-port consumer reading multiple ports already expects per-language shapes
— this is how Jackson, Pydantic, serde, and System.Text.Json each have different
shapes; nobody writes a single cross-language ORM wrapper expecting all four to
have the same exception model.

### `@payloadRef` is the schema source — symmetric with `template.prompt`

The output parser validates against the value-object referenced by the
`template.output`'s `@payloadRef`. Adopters who need different input vs output
shapes declare two `object.value` VOs and point `template.prompt`'s `@payloadRef`
at one, `template.output`'s `@payloadRef` at the other. No new attribute is needed.

### `meta verify` extends to cover output drift

The build-time drift gate (`meta verify`, FR-004 Plan #3 T6) extends to check
`template.output` parser-schema ↔ payload-VO drift. The existing `verify.ts` (TS)
gains a per-subtype branch:

- `template.prompt` → existing check: template variables ↔ payload-VO field names.
- `template.output` → new check: parser-emitted schema ↔ payload-VO field names.

`meta verify`'s diagnostic output gains a `kind: "prompt" | "output"` field on each
finding so consumers (and CI dashboards) can distinguish drift type.

Per-port `meta verify` equivalents (C# already ships; Python/Java when their CLIs
mature) follow the same extension pattern.

## Consequences

### Cross-port rollout sequence

| Port | Codegen layer status | FR6-port can land when |
|---|---|---|
| **TypeScript** | Shipped (`@metaobjectsdev/codegen-ts/payload-codegen`; `generateRenderHandle`/`generatePayloadInterfaces` since 0.6.0) | Now. **FR6-ts is the first implementation.** |
| **C#** | Shipped (`MetaObjects.Render` + `MetaObjects.Codegen` per CLAUDE.md) | Soon. **FR6-csharp** follows TS — extends existing render+verify to emit `Parse`/`TryParse` for output. |
| **Python** | Not shipped yet (planned post-H3) | When Python codegen layer ships. **FR6-python sketches the design**; implementation gated. |
| **Java** | Not shipped yet (planned in H4 — TS codegen Java target) | When Java codegen ships. **FR6-java sketches the design**; implementation gated. |

The cross-port story is **staggered**, not coordinated. Each port adopts when its
codegen layer is ready. The ADR is the durable contract that all four ports converge on.

### What this unblocks

- **TS adopters using LLMs for structured output.** First-class typed parsers
  alongside the existing prompt renderers.
- **`meta verify` becomes the universal template drift gate** — covers both
  subtypes, not just prompt.
- **Future provider-schema codegen (FR6.1?)** can extend this without re-designing —
  the schema is already derivable from the same `@payloadRef`; emitting it as a
  side artifact is small.

### What this explicitly does NOT do

- **Bless a specific LLM provider's structured-output API.** OpenAI, Anthropic, Gemini
  each have different formats; adopters compose with whichever they use.
- **Unify the parse-error shape across ports.** Each port's adopters get
  language-idiomatic behavior, not a forced cross-port type system.
- **Generate the LLM-call layer.** Codegen produces metadata-derived artifacts;
  network calls remain consumer-owned.

## Alternatives considered

### Alt 1: Cross-port uniform `Result<T>` type

Rejected. Fights Python and Java idioms (exception-based). Forces every adopter in
those ports to write non-idiomatic `if not result.ok: ...` instead of try/except.
The TS-internal mental model (Result is good) doesn't generalize.

### Alt 2: Throw-only everywhere

Rejected. Ties TS adopters to try/catch in edge / serverless contexts where exception
control flow is more expensive. TS ecosystem (Zod, Vercel AI SDK) has converged on
dual APIs; ignoring that is hostile to adoption.

### Alt 3: Per-port idiomatic, hard contract via codegen-of-the-codegen

Rejected. Generating each port's parser-emission template from a meta-meta-spec is
over-engineering. Direct hand-written codegen templates per port (with cross-port
documentation discipline) is the right granularity.

### Alt 4: Emit provider-side schema artifacts instead of parsers

Rejected (for this FR). The parsing-on-receipt case is what every consumer does
regardless of provider; provider-side schemas are convenience for specific provider
integrations. Could be a follow-on FR.

### Alt 5: Generate a combined "workflow" handle (render → call → parse)

Rejected. The LLM-call layer is wildly varied per consumer (provider, model,
streaming, retries, fallback chains, observability). Folding it into codegen forces
design choices we don't get to make. Consumer composes render + parse with their
own call layer.

### Alt 6: Defer FR6 entirely until adopters report concrete demand

Rejected. Adopter demand has surfaced (the `template.output` subtype exists because
the FR-004 design anticipated structured output; consumers are now hitting the gap).
Deferring is just slow-rolling.

## References

- FR-004 design: `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`
- FR6 parent (this ADR's implementation FR): `docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md`
- Per-port FRs: `fr6-ts.md`, `fr6-csharp.md`, `fr6-python.md`, `fr6-java.md`
- ADR-0001 — Cross-language metadata→native-type binding.
- ADR-0008 — Parameter-passing generated repo helpers (companion FR-family ADR).
- Industry: Zod (TS), Vercel AI SDK (`generateObject`/`safeGenerateObject`), Pydantic v2,
  Instructor (Python), Jackson, .NET BCL `Parse`/`TryParse` convention.
