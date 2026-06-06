"""CI gate for the AI LLM-call trace recorder (Slice 1, Python port).

No database required. Covers:
- the CONTRACT gate: ``build_llm_call_row`` writes exactly the field set the
  SHIPPED ``metaobjects::ai::LlmCallBase`` declares (loaded from
  ``library/ai/llm-call.yaml``) — a divergence becomes a build failure;
- ``NullLlmCallRecorder`` is a no-op;
- ``ObjectManagerLlmCallRecorder`` NEVER raises on a write failure and routes the
  error to ``on_error`` (telemetry must not break the app).
"""
from __future__ import annotations

from pathlib import Path

from metaobjects import FileSource, MetaDataLoader
from metaobjects.runtime import (
    LlmCallInput,
    NullLlmCallRecorder,
    ObjectManagerLlmCallRecorder,
    build_llm_call_row,
)


def _repo_file(rel: str) -> Path:
    cur = Path(__file__).resolve()
    for parent in cur.parents:
        candidate = parent / rel
        if candidate.exists():
            return candidate
    raise RuntimeError(f"could not locate {rel} from {Path(__file__)}")


def _sample_input() -> LlmCallInput:
    return LlmCallInput(
        span_id="11111111-1111-4111-8111-111111111111",
        trace_id="22222222-2222-4222-8222-222222222222",
        call_type="greeting",
        started_at="2023-11-14T17:13:20+00:00",
        llm_request={"prompt": "say hi"},
        llm_response={"greeting": "hello", "score": 7},
        status="ok",
        error_detail=None,
        system="you are a greeter",
        request_model="claude-x",
        response_model="claude-x",
        input_tokens=12,
        output_tokens=8,
        cost_minor=1500,
        latency_ms=345,
        finish_reason="stop",
    )


def test_build_row_matches_shipped_llm_call_base_field_set() -> None:
    """The base row's keys == the shipped LlmCallBase concrete entity's fields."""
    loader = MetaDataLoader(strict=True)
    result = loader.load([FileSource(_repo_file("library/ai/llm-call.yaml"))])
    assert not result.errors, f"shipped library failed to load: {result.errors}"

    llm_call = None
    for obj in result.root.children():
        if obj.name.endswith("LlmCall") and not obj.name.endswith("LlmCallBase"):
            llm_call = obj
            break
    assert llm_call is not None, "concrete LlmCall entity not found in library/ai/llm-call.yaml"

    shipped_fields = {f.name for f in llm_call.fields()}
    row_keys = set(build_llm_call_row(_sample_input()).keys())
    assert row_keys == shipped_fields, (
        "build_llm_call_row must write exactly the shipped LlmCallBase field set. "
        f"row-only={row_keys - shipped_fields}, shipped-only={shipped_fields - row_keys}"
    )


def test_build_row_carries_values_and_null_defaults() -> None:
    row = build_llm_call_row(_sample_input())
    assert row["spanId"] == "11111111-1111-4111-8111-111111111111"
    assert row["callType"] == "greeting"
    assert row["status"] == "ok"
    assert row["errorDetail"] is None
    assert row["parentSpanId"] is None  # absent → None
    assert row["sessionId"] is None
    # Raw request/response stored as native JSON (pg8000 binds dict→jsonb).
    assert row["llmRequest"] == {"prompt": "say hi"}
    assert row["llmResponse"] == {"greeting": "hello", "score": 7}


def test_null_recorder_is_a_noop() -> None:
    NullLlmCallRecorder().record({"spanId": "x"})  # must not raise


class _RaisingOm:
    def create(self, entity_name: str, data: dict) -> dict:
        raise RuntimeError("boom")


def test_db_recorder_never_raises_and_calls_on_error() -> None:
    captured: list[BaseException] = []
    recorder = ObjectManagerLlmCallRecorder(
        _RaisingOm(), "metaobjects::ai::LlmCall", on_error=captured.append
    )
    recorder.record({"spanId": "x"})  # must not raise
    assert len(captured) == 1
    assert isinstance(captured[0], RuntimeError)


def test_db_recorder_default_on_error_swallows() -> None:
    # No on_error supplied → failure is swallowed silently (never propagates).
    ObjectManagerLlmCallRecorder(_RaisingOm(), "metaobjects::ai::LlmCall").record({"spanId": "x"})
