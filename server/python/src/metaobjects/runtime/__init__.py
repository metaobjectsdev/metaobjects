"""Minimal runtime persistence layer — ObjectManager + Postgres driver.

Cross-port shape mirrors TS runtime-ts and Java ObjectManagerDB: method-based
query API (`find_by_id` / `find_many` / `count`) that translates a Filter dict
into parameterized SQL via a pluggable driver. The corpus query scenarios
exercise eq/ne/gt/gte/lt/lte/in/like/isNull operators + the top-level `and:`
combinator + asc/desc sort + limit/offset.
"""
from .dialect import MYSQL, POSTGRES, SQLITE, Dialect
from .drivers import MySqlDriver, SqliteDriver
from .object_manager import DbApiDriver, Filter, ObjectManager, PostgresDriver
from .validator_runner import ValidationFailure, ValidationResult, run_validators
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
    "DbApiDriver",
    "Dialect",
    "Filter",
    "MYSQL",
    "MySqlDriver",
    "POSTGRES",
    "SQLITE",
    "SqliteDriver",
    "ObjectManager",
    "PostgresDriver",
    "ValidationFailure",
    "ValidationResult",
    "run_validators",
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
