"""SQL dialects the ObjectManager can emit for: Postgres, SQLite and MySQL.

A :class:`Dialect` owns every engine-specific fact the read and write paths need, so the
ObjectManager itself stays one implementation:

* how an identifier is quoted (Postgres and SQLite use ``"``; MySQL uses a backtick and the
  runtime never relies on ``ANSI_QUOTES``) and what a bound parameter looks like (``%s`` for
  pg8000 / PyMySQL, ``?`` for the stdlib ``sqlite3``);
* whether ``INSERT`` / ``UPDATE`` can ``RETURNING`` the row (Postgres and SQLite >= 3.35 can;
  MySQL cannot, so the ObjectManager re-reads the row by its key);
* how ``LIKE`` stays case-SENSITIVE (ADR-0049) where the engine's default is not;
* how a native Python value is BOUND (``encode_param``) and how what the driver hands back is
  turned into the native Python type the metadata declares (``decode_value``).

The Postgres dialect is the identity on both value hooks: pg8000 already speaks native types
(ADR-0019). SQLite and MySQL decode by the FIELD's declared subtype, because neither engine
has the column types Postgres has (a SQLite boolean is ``0``/``1``, its date and uuid are
``TEXT``; a MySQL ``TIME`` arrives as a ``timedelta``, its ``SUM`` of an integer as a
``Decimal``), so the declared type is the only authority on what a value means.
"""
from __future__ import annotations

import datetime as _dt
import decimal as _decimal
import json as _json
import sqlite3 as _sqlite3
import uuid as _uuid
from typing import Any

from ..codegen.runtime.decimal_wire import decimal_from_double15
from ..meta.core.field import field_constants as fc
from ..meta.core.field.meta_field import MetaField
from ..meta.persistence.db import db_constants as dbc

#: Postgres type OIDs the serialization boundary keys the int4-vs-int8 wire rule on
#: (``tests/integration/normalization.py``). A dialect with no OIDs of its own reports the
#: equivalent for the FIELD's declared subtype, so one boundary serves every engine.
PG_OID_INT8 = 20
PG_OID_INT4 = 23


def sqlite_supports_returning() -> bool:
    """``INSERT/UPDATE ... RETURNING`` arrived in SQLite 3.35."""
    return _sqlite3.sqlite_version_info >= (3, 35, 0)


class Dialect:
    """Postgres behaviour; SQLite and MySQL override only what differs."""

    name = "postgres"
    placeholder = "%s"
    #: True when ``INSERT`` / ``UPDATE`` can ``RETURNING`` the written row.
    supports_returning = True
    #: True when the driver has no column OIDs, so the runtime derives type codes from fields.
    synthesizes_type_codes = False
    #: The row-of-defaults INSERT tail (``INSERT INTO t <this>``).
    default_values = "DEFAULT VALUES"
    #: What ``LIMIT`` must be to mean "no limit" when only an ``OFFSET`` is given (``""``: the
    #: engine takes an ``OFFSET`` alone).
    unbounded_limit = ""

    def quote(self, ident: str) -> str:
        if '"' in ident:
            raise ValueError(f"unsafe identifier: {ident}")
        return f'"{ident}"'

    def like_clause(self, quoted_column: str, pattern: str) -> tuple[str, list[Any]]:
        """``col LIKE pattern`` with the pattern verbatim and the match case-SENSITIVE."""
        return f"{quoted_column} LIKE {self.placeholder}", [pattern]

    def order_term(self, quoted_column: str, descending: bool) -> str:
        """One ``ORDER BY`` term with nulls LARGER than any value: ASC puts them last, DESC
        first, on every engine. That is Postgres's own default, so this is its native form;
        SQLite and MySQL would put nulls first on ASC."""
        return f"{quoted_column} {'DESC NULLS FIRST' if descending else 'ASC NULLS LAST'}"

    def false_predicate(self) -> str:
        return "FALSE"

    def encode_param(self, value: Any) -> Any:
        """A native Python value as the driver binds it."""
        return value

    def decode_value(self, field: MetaField, value: Any) -> Any:
        """What the driver returned for *field*, as the native Python type it declares."""
        return value

    def type_code(self, field: MetaField) -> int | None:
        """The Postgres-OID-equivalent wire discriminator of *field*, or ``None``."""
        sub = field.sub_type
        if sub in (fc.FIELD_SUBTYPE_LONG, fc.FIELD_SUBTYPE_CURRENCY):
            return PG_OID_INT8
        if sub == fc.FIELD_SUBTYPE_INT:
            return PG_OID_INT4
        return None


class PostgresDialect(Dialect):
    pass


# ----------------------------------------------------------------------------
# Shared decoding for the engines whose driver returns storage-class values
# ----------------------------------------------------------------------------


def _is_instant(field: MetaField) -> bool:
    """ADR-0036 Wave 2: a ``field.timestamp`` is an instant unless ``@localTime`` opts out."""
    return field.get_meta_attr(dbc.FIELD_ATTR_LOCAL_TIME) is not True  # ADR-0039 resolving


def _parse_timestamp(text: str) -> _dt.datetime:
    iso = text.strip().replace(" ", "T")
    if iso.endswith(("Z", "z")):
        iso = iso[:-1] + "+00:00"
    return _dt.datetime.fromisoformat(iso)


def _as_timestamp(field: MetaField, value: Any) -> Any:
    """An instant is tz-aware UTC, a ``@localTime`` timestamp a naive wall clock. The engines
    here hold both as a UTC wall clock with no zone, so a naive value is read AS UTC."""
    if isinstance(value, str):
        value = _parse_timestamp(value)
    if not isinstance(value, _dt.datetime):
        return value
    if _is_instant(field):
        if value.tzinfo is None:
            return value.replace(tzinfo=_dt.timezone.utc)
        return value.astimezone(_dt.timezone.utc)
    return value.replace(tzinfo=None)


def _as_int(value: Any) -> Any:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, _decimal.Decimal) and value == value.to_integral_value():
        return int(value)
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return value
    return value


def _decode_storage_value(field: MetaField, value: Any) -> Any:
    """Decode a SQLite / MySQL value by the field's declared subtype."""
    if value is None:
        return None
    sub = field.sub_type
    if sub == fc.FIELD_SUBTYPE_BOOLEAN:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float, _decimal.Decimal)):
            return value != 0
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "t")
        return value
    if sub in (fc.FIELD_SUBTYPE_INT, fc.FIELD_SUBTYPE_LONG, fc.FIELD_SUBTYPE_CURRENCY):
        return _as_int(value)
    if sub in (fc.FIELD_SUBTYPE_FLOAT, fc.FIELD_SUBTYPE_DOUBLE):
        if isinstance(value, (int, _decimal.Decimal)) and not isinstance(value, bool):
            return float(value)
        return value
    if sub == fc.FIELD_SUBTYPE_DECIMAL:
        if isinstance(value, _decimal.Decimal):
            return value
        if isinstance(value, float):
            # SQLite (ADR-0019 Amendment 1, W4): NUMERIC affinity keeps a decimal as an INTEGER or
            # a REAL, so the value is exact to 15 significant digits: read it as such.
            return decimal_from_double15(value)
        if isinstance(value, (int, str)) and not isinstance(value, bool):
            return _decimal.Decimal(str(value))
        return value
    if sub == fc.FIELD_SUBTYPE_DATE:
        if isinstance(value, _dt.datetime):
            return value.date()
        if isinstance(value, str):
            return _dt.date.fromisoformat(value[:10])
        return value
    if sub == fc.FIELD_SUBTYPE_TIME:
        if isinstance(value, _dt.timedelta):  # PyMySQL spells a TIME as a timedelta
            seconds = int(value.total_seconds())
            micro = value.microseconds
            return _dt.time(seconds // 3600 % 24, seconds // 60 % 60, seconds % 60, micro)
        if isinstance(value, str):
            return _dt.time.fromisoformat(value)
        return value
    if sub == fc.FIELD_SUBTYPE_TIMESTAMP:
        return _as_timestamp(field, value)
    if sub == fc.FIELD_SUBTYPE_UUID:
        if isinstance(value, str):
            return _uuid.UUID(value)
        if isinstance(value, bytes) and len(value) == 16:
            return _uuid.UUID(bytes=value)
        return value
    if sub in (fc.FIELD_SUBTYPE_OBJECT, fc.FIELD_SUBTYPE_MAP):
        if isinstance(value, (str, bytes, bytearray)):
            storage = field.get_meta_attr(fc.FIELD_ATTR_STORAGE)  # ADR-0039 resolving
            if storage != "flattened":
                return _json.loads(value)
        return value
    return value


def _timestamp_text(value: _dt.datetime) -> str:
    """The text an instant is stored as: UTC, millisecond resolution, ``Z`` iff it was aware."""
    aware = value.tzinfo is not None
    if aware:
        value = value.astimezone(_dt.timezone.utc).replace(tzinfo=None)
    text = value.strftime("%Y-%m-%dT%H:%M:%S") + f".{value.microsecond // 1000:03d}"
    return text + "Z" if aware else text


class SqliteDialect(Dialect):
    """SQLite through the stdlib ``sqlite3`` (qmark parameters)."""

    name = "sqlite"
    placeholder = "?"
    synthesizes_type_codes = True
    unbounded_limit = "-1"

    @property
    def supports_returning(self) -> bool:  # type: ignore[override]
        return sqlite_supports_returning()

    def like_clause(self, quoted_column: str, pattern: str) -> tuple[str, list[Any]]:
        # SQLite's LIKE ignores ASCII case and has no switch short of a connection pragma;
        # GLOB is case-sensitive. A verbatim SQL pattern has only `%` and `_` as wildcards,
        # so translate those and neutralise GLOB's own specials.
        out: list[str] = []
        for ch in pattern:
            if ch == "%":
                out.append("*")
            elif ch == "_":
                out.append("?")
            elif ch in "*?[":
                out.append(f"[{ch}]")
            else:
                out.append(ch)
        return f"{quoted_column} GLOB {self.placeholder}", ["".join(out)]

    def false_predicate(self) -> str:
        return "0 = 1"

    def encode_param(self, value: Any) -> Any:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, _uuid.UUID):
            return str(value)
        if isinstance(value, _decimal.Decimal):
            # SQLite has no decimal type: a NUMERIC column stores an INTEGER or a REAL, and a
            # view column (an AVG, a ratio) has no affinity at all, so a bound TEXT would
            # compare as text and sort after every number. Bind the number.
            return int(value) if value == value.to_integral_value() else float(value)
        if isinstance(value, _dt.datetime):
            return _timestamp_text(value)
        if isinstance(value, _dt.date):
            return value.isoformat()
        if isinstance(value, _dt.time):
            return value.isoformat()
        return value

    def decode_value(self, field: MetaField, value: Any) -> Any:
        return _decode_storage_value(field, value)


class MySqlDialect(Dialect):
    """MySQL 8 through PyMySQL (``%s`` parameters, backtick identifiers)."""

    name = "mysql"
    supports_returning = False
    synthesizes_type_codes = True
    default_values = "() VALUES ()"
    unbounded_limit = "18446744073709551615"

    def order_term(self, quoted_column: str, descending: bool) -> str:
        # No NULLS FIRST/LAST on MySQL: a leading `col IS NULL` key (0 for a value, 1 for null).
        d = "DESC" if descending else "ASC"
        return f"({quoted_column} IS NULL) {d}, {quoted_column} {d}"

    def quote(self, ident: str) -> str:
        if "`" in ident:
            raise ValueError(f"unsafe identifier: {ident}")
        return f"`{ident}`"

    def like_clause(self, quoted_column: str, pattern: str) -> tuple[str, list[Any]]:
        # The default collation is case-INSENSITIVE; BINARY makes the match case-sensitive.
        return f"{quoted_column} LIKE BINARY {self.placeholder}", [pattern]

    def encode_param(self, value: Any) -> Any:
        if isinstance(value, _uuid.UUID):
            return str(value)
        if isinstance(value, _dt.datetime) and value.tzinfo is not None:
            # A DATETIME has no zone and the runtime stores the UTC wall clock.
            return value.astimezone(_dt.timezone.utc).replace(tzinfo=None)
        if isinstance(value, _dt.time):
            return value.isoformat()
        return value

    def decode_value(self, field: MetaField, value: Any) -> Any:
        return _decode_storage_value(field, value)


POSTGRES = PostgresDialect()
SQLITE = SqliteDialect()
MYSQL = MySqlDialect()
