# Python parser-on-receipt

For every RESPONDING `template.prompt` — one declaring `@responseRef` — the
`output-parser` generator (run via `metaobjects gen`) emits a **typed parser** that
validates a model's reply against that shape's Pydantic model. ADR-0052: the tier binds
`@responseRef`, never `@payloadRef` (which types the request the prompt renders
outbound), and a `template.output` gets no parser at all. This is the receive side only —
codegen emits **no** provider/LLM-call layer; you compose the call yourself. The record
class comes from the sibling `payload` generator, so the parser and the record can't
silently drift.

## Contents
- Wire the generators
- What it emits
- The output-format prompt fragment (FR-010)
- The three-step consumer pattern
- Recommended LLM caller (bring-your-own)
- Consumer dependency
- Drift gate

## Wire the generators

Select `output-parser` (the `payload` generator that emits the `<Name>Response` it
parses into runs alongside it):

```bash
metaobjects gen ./metadata --out ./generated --generators payload,output-parser
```

`metaobjects gen --list` shows every generator name; the programmatic
`run_gen(..., generators=[...])` path takes the same names.

## What it emits

Per responding `template.prompt`, `metaobjects gen` writes one
`<template_name>_response_parser.py` with a single throw-only entry point. Python uses one API (not TS's
`parse`/`safeParse`) because raising `pydantic.ValidationError` is the idiomatic
failure — the pydantic / Instructor / FastAPI norm; a Result-style wrapper would be
un-Pythonic.

```python
# generated <template_name>_response_parser.py (shape)
from .npc_response_response import NpcResponseResponse   # the @responseRef record (Pydantic v2 BaseModel)

def parse_npc_response(text: str) -> NpcResponseResponse:
    """Validates text against the payload model.

    Raises:
        pydantic.ValidationError: when the input does not match the schema.
    """
    ...
```

Every responding prompt ALSO gets a **tolerant** best-effort variant —
`extract_lenient_<name>_with_loader(root, text) -> ExtractionResult[<Name>ResponseExtracted]`
(from the `metaobjects` render `extract` engine) for cases where you want a classified
per-field report rather than a raise. The lenient mirror (`<Name>ResponseExtracted`) uses
`Optional[...]` fields — a missing/malformed component is `None`, not a raise.

The STRICT `parse_*` is JSON-only (ADR-0053): an `@responseFormat: xml` reply gets the
tolerant path and no `parse_*` at all, because strict all-or-nothing semantics layered
over a REPAIRING XML reader would raise or accept based on how much repair happened.

## The response-format prompt fragment (FR-010)

For every responding `template.prompt`, the `output-prompt` generator (run via
`metaobjects gen`) emits one `<template_name>_response_format.py` module exposing
`render_<name>_format(overrides=None) -> str`, backed by the render engine's
`render_output_format()` — the "produce your answer like this" fragment for the
model:

```bash
metaobjects gen ./metadata --out ./generated --generators payload,output-prompt
```

`@promptStyle` on the `template.prompt` (`guide` default / `inline` / `exampleOnly`)
controls the fragment's presentation; guidance is never emitted as comments. Skipped for
`template.output` nodes and an unresolved `@responseRef` — the same skip contract as the
`output-parser` generator. There is NO format gate: the old `@format ∈ {json,xml}` test
read the syntax of the outbound body to decide whether to describe the reply, so a
text-bodied prompt asking for a JSON answer got no fragment. The baked spec's root name
is the response class name, agreeing with the parser's `extract_<name>()` root.

## The three-step consumer pattern

Render the prompt → call your LLM client (provider-agnostic; nothing is generated
here) → parse the response with the generated parser:

```python
from pydantic import ValidationError
from .npc_response_response_parser import parse_npc_response

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
