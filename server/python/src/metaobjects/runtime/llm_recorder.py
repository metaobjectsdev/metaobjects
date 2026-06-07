"""LLM-call trace recorder seam + base-row factory (AI LLM-call trace persistence).

Python port of the TS ``runtime-ts/src/llm-recorder.ts`` and Java
``omdb/.../ai/`` recorder. ``build_llm_call_row`` produces the base trace row —
exactly the 18 ``metaobjects::ai::LlmCallBase`` fields — and the recorder
persists it through the runtime write path (:meth:`ObjectManager.create`).

The recorder does NOT extract a typed VO; the typed ``voRequest``/``voResponse``
columns are set by the generated per-entity ``record_<entity>`` helper (Slice 2)
or by the caller on the returned row, matching the TS/Java contract.

Cross-port note (Tier-2, driver-driven): the raw ``llmRequest``/``llmResponse``
columns are ``field.string`` pinned to a jsonb column. pg8000 binds a native
Python ``dict``/``list`` straight to jsonb (a raw ``str`` would not cast), so this
port stores the request/response as native JSON values — unlike TS (JSON string)
and Java (verbatim string). The typed ``voResponse`` contract is identical across
all ports.

The call carries the model response as raw TEXT (``llm_response_text``, mirroring
TS ``llmResponseText`` / Java ``llmResponseText``) — what the model actually
returned. For the raw ``llmResponse`` jsonb column we parse that text into a native
JSON value when it IS valid JSON (clean structured responses store as jsonb), and
otherwise wrap it as ``{"text": <raw>}`` so the column is always a valid jsonb
value (prose / non-JSON / truncated responses never break the bind). See
:func:`_json_or_wrap`.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from .object_manager import ObjectManager

#: Call-outcome sentinels (mirror Java LlmCallInput.STATUS_*).
STATUS_OK = "ok"
STATUS_ERROR = "error"

#: A trace row keyed by metadata field name (the shape ObjectManager.create takes).
LlmCallRow = dict[str, Any]

# Base field names — the LlmCallBase contract (cross-port identical).
_F_TRACE_ID = "traceId"
_F_SPAN_ID = "spanId"
_F_PARENT_SPAN_ID = "parentSpanId"
_F_SESSION_ID = "sessionId"
_F_CALL_TYPE = "callType"
_F_SYSTEM = "system"
_F_REQUEST_MODEL = "requestModel"
_F_RESPONSE_MODEL = "responseModel"
_F_INPUT_TOKENS = "inputTokens"
_F_OUTPUT_TOKENS = "outputTokens"
_F_COST_MINOR = "costMinor"
_F_LATENCY_MS = "latencyMs"
_F_FINISH_REASON = "finishReason"
_F_STATUS = "status"
_F_ERROR_DETAIL = "errorDetail"
_F_STARTED_AT = "startedAt"
_F_LLM_REQUEST = "llmRequest"
_F_LLM_RESPONSE = "llmResponse"


@dataclass
class LlmCallInput:
    """The call fields driving a base trace row.

    ``llm_request`` is a STRUCTURED request object (dict/list/scalar) stored into
    the raw ``llmRequest`` jsonb column as a native JSON value — see the module
    docstring. ``llm_response_text`` is the raw model response TEXT (mirroring TS
    ``llmResponseText`` / Java ``llmResponseText``); the raw ``llmResponse`` jsonb
    column is derived from it by :func:`_json_or_wrap`. ``started_at`` is an
    ISO-8601 string (or a native ``datetime``); the field.timestamp write codec
    coerces it.
    """

    span_id: str
    trace_id: str
    call_type: str
    started_at: Any
    llm_request: Any
    llm_response_text: str
    status: str  # STATUS_OK | STATUS_ERROR
    error_detail: str | None
    parent_span_id: str | None = None
    session_id: str | None = None
    system: str | None = None
    request_model: str | None = None
    response_model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_minor: int | None = None
    latency_ms: int | None = None
    finish_reason: str | None = None


class LlmCallRecorder(Protocol):
    """Write-side seam for persisting a trace row. Implementations MUST NOT raise
    on a persistence failure (telemetry never breaks the app)."""

    def record(self, row: LlmCallRow) -> None: ...


class NullLlmCallRecorder:
    """No-op recorder (testing / disabled tracing)."""

    def record(self, row: LlmCallRow) -> None:  # noqa: D401 - deliberate no-op
        return None


class ObjectManagerLlmCallRecorder:
    """Persist a trace row via :meth:`ObjectManager.create`. Never raises — a write
    failure routes to ``on_error`` (default: swallow)."""

    def __init__(
        self,
        om: ObjectManager,
        entity_name: str,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        self._om = om
        self._entity_name = entity_name
        self._on_error = on_error if on_error is not None else (lambda _e: None)

    def record(self, row: LlmCallRow) -> None:
        try:
            self._om.create(self._entity_name, row)
        except Exception as err:  # noqa: BLE001 - telemetry must never propagate
            self._on_error(err)


def _json_or_wrap(text: str | None) -> Any:
    """Coerce a raw response TEXT into an always-valid jsonb value for the raw
    ``llmResponse`` column.

    pg8000 binds a native ``dict``/``list``/scalar straight to jsonb (a raw ``str``
    would not cast — see the module docstring), so clean JSON responses parse to
    their native value and prose / non-JSON / truncated responses fall back to a
    ``{"text": <raw>}`` wrapper that is always valid jsonb. ``None`` text → ``None``.
    """
    if text is None:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return {"text": text}


def build_llm_call_row(inp: LlmCallInput) -> LlmCallRow:
    """Build the base trace row — key set is exactly LlmCallBase's 18 fields.

    The typed ``voRequest``/``voResponse`` columns are NOT set here; the caller
    (or the generated helper) adds them to the returned row.
    """
    return {
        _F_TRACE_ID: inp.trace_id,
        _F_SPAN_ID: inp.span_id,
        _F_PARENT_SPAN_ID: inp.parent_span_id,
        _F_SESSION_ID: inp.session_id,
        _F_CALL_TYPE: inp.call_type,
        _F_SYSTEM: inp.system,
        _F_REQUEST_MODEL: inp.request_model,
        _F_RESPONSE_MODEL: inp.response_model,
        _F_INPUT_TOKENS: inp.input_tokens,
        _F_OUTPUT_TOKENS: inp.output_tokens,
        _F_COST_MINOR: inp.cost_minor,
        _F_LATENCY_MS: inp.latency_ms,
        _F_FINISH_REASON: inp.finish_reason,
        _F_STATUS: inp.status,
        _F_ERROR_DETAIL: inp.error_detail,
        _F_STARTED_AT: inp.started_at,
        # Raw request → the structured request object bound straight to jsonb.
        _F_LLM_REQUEST: inp.llm_request,
        # Raw response → the response TEXT parsed to native JSON when it parses,
        # else wrapped as {"text": ...} so the jsonb bind is always valid.
        _F_LLM_RESPONSE: _json_or_wrap(inp.llm_response_text),
    }


def truncate_row(row: LlmCallRow, max_chars: int) -> LlmCallRow:
    """Cap the raw ``llmRequest``/``llmResponse`` columns when they are strings.

    Adopters compose this into a ``redact`` to bound trace-row size. Non-string
    (native JSON) values pass through unchanged; all other fields are untouched.
    """

    def cap(v: Any) -> Any:
        return v[:max_chars] if isinstance(v, str) and len(v) > max_chars else v

    return {**row, _F_LLM_REQUEST: cap(row.get(_F_LLM_REQUEST)), _F_LLM_RESPONSE: cap(row.get(_F_LLM_RESPONSE))}


def persist_llm_call_row(
    recorder: LlmCallRecorder,
    row: LlmCallRow,
    redact: Callable[[LlmCallRow], LlmCallRow] | None = None,
) -> None:
    """Shared persist step: redact then record. Used by record_llm_call AND the
    generated typed helper, so redaction applies on both paths."""
    recorder.record(redact(row) if redact is not None else row)


def record_llm_call(
    inp: LlmCallInput,
    recorder: LlmCallRecorder,
    redact: Callable[[LlmCallRow], LlmCallRow] | None = None,
) -> tuple[str, str | None]:
    """Persist one base trace row (envelope + raw I/O). Generic — does not extract.
    Returns ``(status, error_detail)``."""
    persist_llm_call_row(recorder, build_llm_call_row(inp), redact)
    return inp.status, inp.error_detail
