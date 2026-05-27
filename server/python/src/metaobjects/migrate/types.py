"""Descriptors + Change union. Port of TS migrate-ts types.ts."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Union

from .sql_type import SqlType


@dataclass(frozen=True)
class ChangeStatus:
    state: Literal["allowed", "blocked"] = "allowed"
    blocked_reason: str | None = None


# ----------------------------------------------------------------------------
# Snapshot descriptors
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class ColumnDescriptor:
    name: str
    sql_type: SqlType
    nullable: bool = True
    # "increment" or "uuid" or None; informational in v1.
    identity: str | None = None


@dataclass(frozen=True)
class IndexDescriptor:
    name: str
    columns: tuple[str, ...]
    unique: bool = False


@dataclass(frozen=True)
class FkDescriptor:
    name: str
    columns: tuple[str, ...]
    ref_table: str
    ref_columns: tuple[str, ...]
    on_delete: str | None = None
    on_update: str | None = None


@dataclass(frozen=True)
class TableDescriptor:
    name: str
    schema: str | None
    columns: tuple[ColumnDescriptor, ...]
    indexes: tuple[IndexDescriptor, ...]
    foreign_keys: tuple[FkDescriptor, ...]
    primary_key: tuple[str, ...]


@dataclass(frozen=True)
class ViewDescriptor:
    name: str
    schema: str | None = None
    # SELECT clause body (everything between `CREATE VIEW <name> AS` and `;`).
    sql: str | None = None


@dataclass(frozen=True)
class SchemaSnapshot:
    tables: tuple[TableDescriptor, ...] = field(default_factory=tuple)
    views: tuple[ViewDescriptor, ...] = field(default_factory=tuple)


# ----------------------------------------------------------------------------
# Change union
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class CreateTable:
    table: TableDescriptor
    status: ChangeStatus = field(default_factory=ChangeStatus)
    kind: Literal["create-table"] = field(default="create-table", init=False)


@dataclass(frozen=True)
class DropTable:
    table: str
    schema: str | None = None
    status: ChangeStatus = field(default_factory=ChangeStatus)
    kind: Literal["drop-table"] = field(default="drop-table", init=False)


@dataclass(frozen=True)
class AddColumn:
    table: str
    schema: str | None
    column: ColumnDescriptor
    status: ChangeStatus = field(default_factory=ChangeStatus)
    kind: Literal["add-column"] = field(default="add-column", init=False)


@dataclass(frozen=True)
class DropColumn:
    table: str
    schema: str | None
    column: str
    status: ChangeStatus = field(default_factory=ChangeStatus)
    kind: Literal["drop-column"] = field(default="drop-column", init=False)


@dataclass(frozen=True)
class AddIndex:
    table: str
    schema: str | None
    index: IndexDescriptor
    status: ChangeStatus = field(default_factory=ChangeStatus)
    kind: Literal["add-index"] = field(default="add-index", init=False)


@dataclass(frozen=True)
class AddFk:
    table: str
    schema: str | None
    fk: FkDescriptor
    status: ChangeStatus = field(default_factory=ChangeStatus)
    kind: Literal["add-fk"] = field(default="add-fk", init=False)


@dataclass(frozen=True)
class CreateView:
    view: ViewDescriptor
    status: ChangeStatus = field(default_factory=ChangeStatus)
    kind: Literal["create-view"] = field(default="create-view", init=False)


Change = Union[CreateTable, DropTable, AddColumn, DropColumn, AddIndex, AddFk, CreateView]
