# Python parser-on-receipt

For every `template.output`, the `output-parser` generator (run via `metaobjects gen`)
emits a **typed parser** that validates an LLM/raw response against the template's
`@payloadRef` payload Pydantic model. This is the receive side only — codegen emits
**no** provider/LLM-call layer; you compose the call yourself. The payload class comes
from the sibling `payload` generator, so the parser and the payload VO can't silently
drift.

## Contents
- Wire the generators
- What it emits
- The output-format prompt fragment (FR-010)
- The three-step consumer pattern
- Recommended LLM caller (bring-your-own)
- Consumer dependency
- Drift gate

## Wire the generators

Select `output-parser` (the `payload` generator that emits the `<Name>Payload` it
parses into runs alongside it):

```bash
metaobjects gen ./metadata --out ./generated --generators payload,output-parser
```

`metaobjects gen --list` shows every generator name; the programmatic
`run_gen(..., generators=[...])` path takes the same names.

## What it emits

Per `template.output`, `metaobjects gen` writes one `<template_name>_output_parser.py`
with a single throw-only entry point. Python uses one API (not TS's
`parse`/`safeParse`) because raising `pydantic.ValidationError` is the idiomatic
failure — the pydantic / Instructor / FastAPI norm; a Result-style wrapper would be
un-Pythonic.

```python
# generated <template_name>_output_parser.py (shape)
from .npc_response_payload import NpcResponsePayload   # the @payloadRef VO (Pydantic v2 BaseModel)

def parse_npc_response(text: str) -> NpcResponsePayload:
    """Validates text against the payload model.

    Raises:
        pydantic.ValidationError: when the input does not match the schema.
    """
    ...
```

For `@format: json|xml` outputs the generator additionally emits a **tolerant**
best-effort variant — `extract_lenient_<name>(text) -> ExtractionResult[<Name>PayloadExtracted]`
(from the `metaobjects` render `extract` engine) for cases where you want a classified
per-field report rather than a raise. The lenient mirror (`<Name>PayloadExtracted`)
uses `Optional[...]` fields — a missing/malformed component is `None`, not a raise.

## The output-format prompt fragment (FR-010)

For every json/xml-format `template.output`, the `output-prompt` generator (run via
`metaobjects gen`) emits one `<template_name>_output_prompt.py` module exposing
`render_<name>_format(overrides=None) -> str`, backed by the render engine's
`render_output_format()` — the "produce your answer like this" fragment for the
model:

```bash
metaobjects gen ./metadata --out ./generated --generators payload,output-prompt
```

`@promptStyle` on the `template.output` (`guide` default / `inline` / `exampleOnly`)
controls the fragment's presentation; guidance is never emitted as comments. Skipped
for `template.prompt` nodes, non-json/xml `@format`, and unresolved `@payloadRef` —
the same skip contract as the `output-parser` generator. The baked spec's root name
is the payload class name, agreeing with the parser's `extract_<name>()` root.

## The three-step consumer pattern

Render the prompt → call your LLM client (provider-agnostic; nothing is generated
here) → parse the response with the generated parser:

```python
from pydantic import ValidationError
from .npc_response_output_parser import parse_npc_response

text = my_llm_client.complete(prompt_text)   # YOUR code — no generated provider
try:
    npc = parse_npc_response(text)           # raises pydantic.ValidationError on bad shape
except ValidationError as exc:
    log.warning("LLM returned malformed payload: %s", exc)
```

## Recommended LLM caller (bring-your-own)

`metaobjects gen` emits **no** provider/LLM-call layer and never will — calling is a
commodity the ecosystem already solves (ADR-0024). You bring the caller; MetaObjects
owns the typed render → parse (above) → record. For the call step use the idiomatic
Python library:

```python
from litellm import completion   # LiteLLM — recommended

resp = completion(
    model="anthropic/claude-3-5-sonnet",
    messages=[{"role": "system", "content": system_text},
              {"role": "user", "content": prompt_text}],
)
text = resp.choices[0].message.content

npc = parse_npc_response(text)   # the generated parser, above
```

**Recommended: LiteLLM** — one OpenAI-shaped `completion()` over 100+ providers; the
raw text feeds straight into MetaObjects' typed parser/extract. If you want the *LLM*
to enforce the typed shape instead, **Instructor** or **Pydantic-AI** return a
validated Pydantic model — but that overlaps MetaObjects' own typed `extract`, so pick
one boundary, not both.

> The typed-trace **recorder** has shipped on this port too — the `trace-helper`
> generator emits a `record_<entity>(recorder, input, redact=None)` helper (per
> concrete entity extending `LlmCallBase` with a `@responseRef`/`@payloadRef`-carrying
> `template.prompt`) that tolerantly extracts the typed response, builds the base
> trace row, and persists it once. What's still TS-only is the **`call<Entity>`
> render→call→record convenience loop** — Python intentionally does not emit it,
> because the `LlmClient` seam it wraps is BYO / vendor-neutral here (ADR-0024). So
> you compose render → your LLM call → the generated `record_<entity>(...)` yourself;
> the parser above is the standalone receive side if you don't even want the
> recorder.

## Consumer dependency

The generated parser imports `pydantic` (v2 — `model_validate_json`); `pip install
pydantic`. The tolerant `extract_lenient_*` variant pulls the `metaobjects` render
`extract` engine, already in the `metaobjects` package.

## Drift gate

The render module's `verify(template_text, fields, *, provider=None,
required_slots=None, required_tags=None) -> list[VerifyError]` walks a Mustache
template's tokens against the payload field tree — each `{{...}}` reference that
doesn't resolve yields a `VerifyError` (empty list = no drift). Assert it is empty in a
pytest test to fail the build on prompt/payload drift; `metaobjects verify`
additionally catches a stale committed parser.
