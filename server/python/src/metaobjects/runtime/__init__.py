"""Minimal runtime persistence layer — ObjectManager + Postgres driver.

Cross-port shape mirrors TS runtime-ts and Java ObjectManagerDB: method-based
query API (`find_by_id` / `find_many` / `count`) that translates a Filter dict
into parameterized SQL via a pluggable driver. The corpus query scenarios
exercise eq/ne/gt/gte/lt/lte/in/like/isNull operators + the top-level `and:`
combinator + asc/desc sort + limit/offset.
"""
from .object_manager import Filter, ObjectManager, PostgresDriver
from .llm_recorder import (
    STATUS_ERROR,
    STATUS_OK,
    LlmCallInput,
    LlmCallRecorder,
    LlmCallRow,
    NullLlmCallRecorder,
    ObjectManagerLlmCallRecorder,
    build_llm_call_row,
    persist_llm_call_row,
    record_llm_call,
    truncate_row,
)

__all__ = [
    "Filter",
    "ObjectManager",
    "PostgresDriver",
    "STATUS_OK",
    "STATUS_ERROR",
    "LlmCallInput",
    "LlmCallRecorder",
    "LlmCallRow",
    "NullLlmCallRecorder",
    "ObjectManagerLlmCallRecorder",
    "build_llm_call_row",
    "persist_llm_call_row",
    "record_llm_call",
    "truncate_row",
]
