"""Runtime persistence layer — the abstract ``ObjectManager`` and ``ObjectManagerDb``.

Cross-port shape mirrors Java ``ObjectManager`` / ``ObjectManagerDB``: ``ObjectManager`` is the
store-neutral contract (method-based API, listeners, transactions); ``ObjectManagerDb`` is the
DB-API implementation that translates a Filter dict into parameterized SQL via a driver
(Postgres, SQLite, MySQL). The corpus query scenarios exercise eq/ne/gt/gte/lt/lte/in/like/isNull
operators + the top-level `and:` combinator + asc/desc sort + limit/offset.
"""
from .dialect import MYSQL, POSTGRES, SQLITE, Dialect
from .drivers import DbApiDriver, MySqlDriver, PostgresDriver, SelectResult, SqliteDriver
from .object_manager import Filter, ObjectManager, PersistenceListener
from .object_manager_db import ObjectManagerDb
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
    "ObjectManagerDb",
    "PersistenceListener",
    "SelectResult",
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
