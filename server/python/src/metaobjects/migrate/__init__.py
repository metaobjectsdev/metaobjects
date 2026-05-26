"""Postgres migration engine — port of TS migrate-ts.

Loads metadata → builds expected schema (tables + views) → diffs against
actual (empty for bootstrap) → emits Postgres DDL. v1 supports the same
shapes the TS port does for the cross-port conformance corpus:

  * tables with PK / unique indexes / FKs (with @onDelete/@onUpdate)
  * NOT NULL inferred from identity.primary + @required
  * VARCHAR(N) from @maxLength on strings
  * @column override else field name
  * views via passthrough (no @via) + aggregate origins
  * mixed-case identifiers double-quoted throughout
"""
from .types import (
    ChangeStatus,
    ColumnDescriptor,
    FkDescriptor,
    IndexDescriptor,
    SchemaSnapshot,
    TableDescriptor,
    ViewDescriptor,
)
from .sql_type import SqlType
from .expected_schema import build_expected_schema
from .diff import diff
from .postgres_emit import emit_postgres

__all__ = [
    "ChangeStatus",
    "ColumnDescriptor",
    "FkDescriptor",
    "IndexDescriptor",
    "SchemaSnapshot",
    "SqlType",
    "TableDescriptor",
    "ViewDescriptor",
    "build_expected_schema",
    "diff",
    "emit_postgres",
]
