# FR6-python — Python `template.output` parser codegen (sketch, gated)

**Status:** Design sketch — gated on Python codegen layer (planned post-H3)
**Date:** 2026-05-25
**Scope:** Python — codegen package (not yet shipped; planned per CLAUDE.md status: "Python codegen + runtime" after Phase 2/3 of loader work)
**Depends on:** [ADR-0010](../../../spec/decisions/ADR-0010-template-output-parser-codegen.md); Python codegen layer existing (not yet)
**Parent:** [FR6 cross-port design](./2026-05-25-fr6-template-output-parser-codegen.md)

## Goal

For every declared `template.output`, the Python codegen emits a parser function
with Python's throw-only convention (matching Pydantic / Instructor / LangChain):

```python
# Generated npc_response_output.py
from pydantic import ValidationError
from .npc_response import NpcResponse

def parse_npc_response(text: str) -> NpcResponse:
    """Parse an LLM response into a typed NpcResponse.

    Raises:
        pydantic.ValidationError: when the input does not match the schema.
    """
    return NpcResponse.model_validate_json(text)
```

Plus eventual `meta verify` extension (Python CLI when it ships).

## Why this is a sketch — implementation gated

Python doesn't have a codegen layer yet. Per CLAUDE.md:

> Python codegen/runtime were out of scope for [Phase 1]... Phase 2/3: complete loader parity ... Then Python codegen + runtime.

When Python codegen ships, this FR ships alongside its first iteration —
`template.output` parser is one of several codegen targets that the Python
codegen will need (parallel to TS's `entityFile()`, `queriesFile()`,
`promptRender()`, `outputParser()`).

## Design (when ready)

### Pydantic v2 alignment

The Python ecosystem has converged on Pydantic v2 for typed-data parsing
(Instructor, FastAPI, LangChain structured output, the modern LLM tooling
landscape). The generated parser uses `<PayloadVO>.model_validate_json(text)` —
the canonical Pydantic call.

### No dual API

Python doesn't have a strong idiomatic dual-API precedent. Pydantic raises
`ValidationError`; callers wrap in `try/except` as needed. Matching the
ecosystem norm, the generated parser is single-API throw-only.

If a Python adopter wants a Result-style API, they wrap the call themselves —
exactly as they would for any Pydantic model.

### Field-type → Pydantic-type mapping

| Field subtype | Pydantic type (on the payload-VO) |
|---|---|
| `field.string` | `str` (with `constr(max_length=N)` for `@maxLength`) |
| `field.int` / `field.long` / `field.short` / `field.byte` | `int` |
| `field.double` / `field.float` | `float` |
| `field.boolean` | `bool` |
| `field.date` / `field.time` / `field.timestamp` | `datetime.{date,time,datetime}` |
| `field.enum` | `Literal[...]` or `Enum` |
| `field.currency` | `int` (minor units) |
| `field.object` | nested Pydantic model |
| `isArray: true` | wrap in `list[...]` |

The output parser then becomes a one-liner — Pydantic does the work.

## Out of scope

Same exclusions as FR6 parent. Plus: no Python implementation until the codegen
layer ships.

## Open questions

When implementation time comes:

1. Pydantic v2 fixed or older Pydantic v1 supported too?
2. Whether to also generate Pydantic-via-JSON-Schema as a side artifact (provider-side
   schema use case — likely out of scope per ADR-0010).
3. The `meta verify` Python CLI extension shape (depends on whether Python ships a
   CLI of its own or shares the TS CLI).
