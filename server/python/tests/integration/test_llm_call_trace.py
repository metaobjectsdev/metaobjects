"""Real-Postgres round-trip oracle for the AI-trace recorder (Slice 1, Python port).

Proves a typed LLM-call trace persists + reads back through the ObjectManager
runtime against a live Postgres: a trace entity extending the SHIPPED
``metaobjects::ai::LlmCallBase`` (library/ai/llm-call.yaml) plus a typed
``voResponse`` (field.object + @objectRef + @storage:jsonb). Asserts BOTH the raw
envelope (the 18 base fields, raw llmRequest/llmResponse jsonb) AND the typed
voResponse jsonb round-trip.

Mirrors test_runtime_return_types: a docker-CLI PostgresContainer + pg8000 +
ObjectManager, schema provisioned by explicit DDL (ADR-0015: pure data-access).
Not part of the default unit run — requires Docker.
"""
from __future__ import annotations

from contextlib import closing
from pathlib import Path

from metaobjects import FileSource, MetaDataLoader
from metaobjects.runtime import (
    LlmCallInput,
    ObjectManager,
    ObjectManagerLlmCallRecorder,
    PostgresDriver,
    build_llm_call_row,
)

from .postgres_container import PostgresContainer

_ENTITY = "GreetingCall"

_DDL = """
CREATE TABLE llm_call (
  "traceId" uuid,
  "spanId" uuid PRIMARY KEY,
  "parentSpanId" uuid,
  "sessionId" varchar(128),
  "callType" varchar(64),
  "system" varchar(256),
  "requestModel" varchar(128),
  "responseModel" varchar(128),
  "inputTokens" integer,
  "outputTokens" integer,
  "costMinor" bigint,
  "latencyMs" integer,
  "finishReason" varchar(64),
  "status" varchar(16),
  "errorDetail" varchar(2000),
  "startedAt" timestamp,
  "llmRequest" jsonb,
  "llmResponse" jsonb,
  "voResponse" jsonb
)
"""


def _repo_file(rel: str) -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / rel).exists():
            return parent / rel
    raise RuntimeError(f"could not locate {rel}")


def _connect(info):
    import pg8000.dbapi

    return pg8000.dbapi.connect(
        host=info.host, port=info.port, user=info.user,
        password=info.password, database=info.database,
    )


def test_typed_trace_round_trips_through_postgres() -> None:
    loader = MetaDataLoader(strict=True)
    result = loader.load([
        FileSource(_repo_file("library/ai/llm-call.yaml")),
        FileSource(Path(__file__).parent / "meta_ai_trace.yaml"),
    ])
    assert not result.errors, f"metadata failed to load: {result.errors}"

    with PostgresContainer() as pg:
        info = pg.info()
        with closing(_connect(info)) as conn:
            cur = conn.cursor()
            cur.execute(_DDL)
            conn.commit()
            cur.close()

            om = ObjectManager(result.root, PostgresDriver(conn))
            # Capture (don't swallow) write failures so the round-trip fails loudly.
            write_errors: list[BaseException] = []
            recorder = ObjectManagerLlmCallRecorder(om, _ENTITY, on_error=write_errors.append)

            inp = LlmCallInput(
                span_id="a3200f4d-49cf-457f-85d8-0eb1e8278df7",
                trace_id="819c543a-80df-4120-9945-ca9ebb6859c6",
                parent_span_id="732a878b-f954-4a90-8c74-21c861bbb46f",
                session_id="session-1",
                call_type="greeting",
                system="you are a greeter",
                started_at="2023-11-14T17:13:20",
                llm_request={"prompt": "say hi", "temperature": 0.2},
                llm_response={"greeting": "hello", "score": 7},
                request_model="claude-x",
                response_model="claude-x",
                input_tokens=12,
                output_tokens=8,
                cost_minor=1500,
                latency_ms=345,
                finish_reason="stop",
                status="ok",
                error_detail=None,
            )

            # Build base row, attach the typed voResponse, persist.
            row = build_llm_call_row(inp)
            row["voResponse"] = {"greeting": "hello", "score": 7}
            recorder.record(row)
            assert not write_errors, f"recorder write failed: {write_errors}"

            # --- read back ---
            loaded = om.find_by_id(_ENTITY, inp.span_id)
            assert loaded is not None, "expected exactly one trace row"

            # envelope
            assert str(loaded["spanId"]) == inp.span_id
            assert str(loaded["traceId"]) == inp.trace_id
            assert str(loaded["parentSpanId"]) == inp.parent_span_id
            assert loaded["sessionId"] == "session-1"
            assert loaded["callType"] == "greeting"
            assert loaded["system"] == "you are a greeter"
            assert loaded["requestModel"] == "claude-x"
            assert loaded["responseModel"] == "claude-x"
            assert int(loaded["inputTokens"]) == 12
            assert int(loaded["outputTokens"]) == 8
            assert int(loaded["costMinor"]) == 1500
            assert int(loaded["latencyMs"]) == 345
            assert loaded["finishReason"] == "stop"
            assert loaded["status"] == "ok"
            assert loaded["errorDetail"] is None
            assert loaded["startedAt"] is not None

            # raw jsonb columns round-trip as native dicts (pg8000 decodes jsonb)
            assert loaded["llmRequest"] == {"prompt": "say hi", "temperature": 0.2}
            assert loaded["llmResponse"] == {"greeting": "hello", "score": 7}

            # typed voResponse jsonb round-trip
            assert loaded["voResponse"] == {"greeting": "hello", "score": 7}
