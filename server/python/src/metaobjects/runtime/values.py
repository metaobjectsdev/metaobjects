"""Value conversion for the runtime persistence layer: authoring form to the native value a
driver binds, and the column value read back to the value a caller sees.

Store-neutral, in the sense that no SQL is spelled here: the write codec (``coerce_write_value``,
``coerce_key_value``, ``coerce_filter_value``), the read codec (``decode_read_value``,
``decode_read_row``, int-backed enums, durations, arrays of value objects), ``@autoSet``
stamping and the column-name rule all work from a field's declared metadata alone. A manager
for any store reuses them, and :class:`~metaobjects.runtime.object_manager_db.ObjectManagerDb`
is the one that binds the results to a DB-API driver.

Per ADR-0019 (runtime return-type contract) the read side returns **native, in-process Python
types**; canonicalization to the cross-port wire form is a serialization-boundary concern
(see ``tests/integration/normalization.py``), never done here.
"""
from __future__ import annotations

import datetime as _dt
import decimal as _decimal
import json as _json
import math as _math
import re as _re
import uuid as _uuid
from collections.abc import Mapping
from typing import Any

from ..codegen.runtime.duration_wire import (
    duration_from_driver,
    format_duration,
    parse_duration_input,
)
from ..meta.core.field import field_constants as fc
from ..meta.core.field.meta_field import MetaField
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY
from ..naming_refs import ref_target
from ..naming import DEFAULT_COLUMN_NAMING, resolve_column_name
from ..meta.persistence.db import db_constants as dbc
from .dialect import POSTGRES, Dialect, DurationParam


# ----------------------------------------------------------------------------
# Write codec — authoring form → native Python type the driver binds (ADR-0019
# write side). pg8000 maps Decimal→numeric, uuid.UUID→uuid, naive datetime→
# timestamp, aware datetime→timestamptz, date→date, time→time, dict→jsonb. We
# only need to turn the corpus' authoring *strings* into those native types; the
# driver does the rest. Mirrors the TS runtime write coercer (type-coercer.ts):
# jsonb objects + native binding per subtype, everything else passes through.
# ----------------------------------------------------------------------------


def field_is_array(field: MetaField) -> bool:
    """Effective array-ness (ADR-0039 resolving): the native ``is_array`` flag OR
    the ``@isArray`` attr, resolved through the ``extends`` super chain so a concrete
    field inheriting array-ness from an abstract parent is honored at write time."""
    return field.resolved_is_array()


_FILTER_INT_SUBTYPES = (fc.FIELD_SUBTYPE_INT, fc.FIELD_SUBTYPE_LONG, fc.FIELD_SUBTYPE_CURRENCY)
_FILTER_FLOAT_SUBTYPES = (fc.FIELD_SUBTYPE_FLOAT, fc.FIELD_SUBTYPE_DOUBLE)


def coerce_filter_value(field: MetaField, value: Any) -> Any:
    """A filter operand as the native type the column compares against.

    A filter value usually arrives as TEXT (the REST grammar ``filter[f][op]=v`` hands the
    repository the raw URL text). Postgres lets the driver pick the column type for a
    bound string; SQLite and MySQL compare a bound string against a number as TEXT, so
    ``count > '0'`` is wrong there. Numeric and boolean operands are parsed from text by
    the field's declared subtype, then the write codec applies as for any bound value."""
    if isinstance(value, str):
        sub = field.sub_type
        if sub in _FILTER_INT_SUBTYPES:
            value = int(value) if _INT_TEXT.match(value) else value
        elif sub in _FILTER_FLOAT_SUBTYPES:
            try:
                value = float(value)
            except ValueError:
                pass
        elif sub == fc.FIELD_SUBTYPE_BOOLEAN:
            lowered = value.strip().lower()
            if lowered in ("true", "1"):
                value = True
            elif lowered in ("false", "0"):
                value = False
    return coerce_write_value(field, value, for_filter=True)


_INT_TEXT = _re.compile(r"^\s*-?\d+\s*$")


_ASCII_DIGITS = "0123456789"
_KEY_INT_SUBTYPES = (fc.FIELD_SUBTYPE_INT, fc.FIELD_SUBTYPE_LONG)
_KEY_DECIMAL_SUBTYPES = (fc.FIELD_SUBTYPE_DECIMAL, fc.FIELD_SUBTYPE_DOUBLE, fc.FIELD_SUBTYPE_FLOAT)


def _is_canonical_decimal_text(text: str, *, fractional: bool) -> bool:
    """Canonical decimal key text: optional ``-``, ASCII digits with no leading zero (a lone
    ``0`` is fine), no ``-0``, and, when *fractional*, an optional ``.`` plus at least one
    digit. Checked character by character: ``int()``/``float()``/``Decimal()`` accept
    whitespace, ``+``, ``_``, exponents, Unicode digits, ``nan`` and ``inf``, and
    ``str.isdigit`` accepts Unicode digits, so none of them may decide."""
    body = text[1:] if text.startswith("-") else text
    whole, dot, frac = body.partition(".")
    if dot and not fractional:
        return False
    if not whole or any(c not in _ASCII_DIGITS for c in whole):
        return False
    if len(whole) > 1 and whole[0] == "0":
        return False
    if dot and (not frac or any(c not in _ASCII_DIGITS for c in frac)):
        return False
    if text.startswith("-") and whole == "0" and all(c == "0" for c in frac):
        return False
    return True


def coerce_key_value(field: MetaField, value: Any) -> Any:
    """A primary-key / id argument as the native value the key column binds.

    A key arrives as TEXT from a route or a ref. For a numeric key field the text must be
    canonical decimal (see :func:`_is_canonical_decimal_text`), else the same ``ValueError``
    the OM raises for any unusable argument; text that names no key never names row 1 or 0.
    A non-text value, or a non-numeric key (string, uuid), goes to the ordinary write codec."""
    if isinstance(value, str):
        sub = field.sub_type
        integer = sub in _KEY_INT_SUBTYPES
        if integer or sub in _KEY_DECIMAL_SUBTYPES:
            if not _is_canonical_decimal_text(value, fractional=not integer) or (
                sub in (fc.FIELD_SUBTYPE_DOUBLE, fc.FIELD_SUBTYPE_FLOAT) and _math.isinf(float(value))
            ):
                owner = field.parent.name if field.parent is not None else "?"
                raise ValueError(
                    f"Entity '{owner}' key field '{field.name}' (field.{sub}) is not canonical decimal text"
                )
            if integer:
                return int(value)
            return _decimal.Decimal(value) if sub == fc.FIELD_SUBTYPE_DECIMAL else float(value)
    return coerce_write_value(field, value)


def coerce_write_value(field: MetaField, value: Any, *, for_filter: bool = False) -> Any:
    if value is None:
        return None
    sub = field.sub_type
    # ADR-0039 own-only: @dbColumnType is a physical column-type override, never
    # inherited via extends (the one deliberately own-only attribute).
    col_type = field.attr(dbc.FIELD_ATTR_DB_COLUMN_TYPE)

    # decimal / currency: a decimal authored as a string → Decimal (exact; never
    # via float). currency is integer minor units — already an int, pass through.
    if sub == fc.FIELD_SUBTYPE_DECIMAL:
        if field_is_array(field) and isinstance(value, list):
            return [None if v is None else v if isinstance(v, _decimal.Decimal) else _decimal.Decimal(str(v)) for v in value]
        return value if isinstance(value, _decimal.Decimal) else _decimal.Decimal(str(value))

    # uuid (logical field.uuid, or a string field pinned to a uuid column):
    # string → uuid.UUID so the driver binds the native uuid type. PG stores it
    # lowercase-canonically regardless of input case.
    #
    # For isArray=true (native uuid[] column, Phase 1): coerce each element in the
    # list. pg8000 binds a Python list[uuid.UUID] to a uuid[] column natively.
    # field.string isArray=true (text[] column) passes through — pg8000 binds
    # list[str] to text[] natively without element conversion.
    if sub == fc.FIELD_SUBTYPE_UUID or col_type == dbc.DB_COLUMN_TYPE_UUID:
        if field_is_array(field) and isinstance(value, list):
            return [v if isinstance(v, _uuid.UUID) else _uuid.UUID(str(v)) for v in value]
        return value if isinstance(value, _uuid.UUID) else _uuid.UUID(str(value))

    # field.duration: an accepted ISO-8601 duration (or a timedelta already in process) →
    # datetime.timedelta, which pg8000 binds as an interval; the SQLite and MySQL dialects
    # bind its microsecond count (Dialect.encode_param), so a filter operand compares and
    # orders as a number there. Anything else — a calendar span, a
    # clock string, a number — is refused here, not by the database.
    if sub == fc.FIELD_SUBTYPE_DURATION:
        if field_is_array(field) and isinstance(value, list):
            return [None if v is None else _duration_write_value(field, v) for v in value]
        return _duration_write_value(field, value)

    # temporal: parse the authoring string to the native type, with tz-awareness
    # driven by the field so the driver binds the correct physical type. ADR-0036
    # Wave 2: field.timestamp is instant / tz-aware BY DEFAULT (→ timestamptz); the
    # rare naive wall-clock case opts out with @localTime:true (→ plain timestamp).
    if sub == fc.FIELD_SUBTYPE_DATE:
        return value if isinstance(value, _dt.date) else _dt.date.fromisoformat(str(value))
    if sub == fc.FIELD_SUBTYPE_TIME:
        return value if isinstance(value, _dt.time) else _dt.time.fromisoformat(str(value))
    if sub == fc.FIELD_SUBTYPE_TIMESTAMP:
        if isinstance(value, _dt.datetime):
            return value
        is_tz = field.get_meta_attr(dbc.FIELD_ATTR_LOCAL_TIME) is not True  # ADR-0039 resolving: @localTime may be inherited
        return _parse_datetime(str(value), tz_aware=is_tz)

    # field.object / field.map stored as a single jsonb column: serialize to a
    # JSON text string so pg8000 sends it as jsonb text (PG assignment-casts text
    # → jsonb). pg8000 binds a native *dict* to jsonb natively, but a native
    # *list* (array-of-VO, isArray:true) it adapts as a Postgres ARRAY literal
    # `{...,...}` which the JSONB column rejects with 22P02 'invalid input syntax
    # for type json' — so we cannot rely on driver magic for the list form.
    # Serializing both shapes to a JSON string is the explicit codec every other
    # port has (Java/Gson, C#/System.Text.Json, TS/JSON.stringify, Kotlin/Jackson)
    # and handles dict (single VO), list (array-of-VO), and [] uniformly.
    #
    # Scope: only jsonb-storage field.object/field.map. A *flattened* field.object
    # is expanded to separate scalar columns (never reaches here as the object
    # node) and must not be touched; a field.string pinned to a jsonb column via
    # @dbColumnType already carries a string value and is left alone above.
    if sub in (fc.FIELD_SUBTYPE_OBJECT, fc.FIELD_SUBTYPE_MAP):
        storage = field.get_meta_attr(fc.FIELD_ATTR_STORAGE)  # ADR-0039 resolving
        if storage != "flattened":  # None / "jsonb" / "subdocument" → single jsonb column
            # A field.duration inside the value object is stored in its canonical form, so the
            # column holds what every port writes (and refuses what is not a duration).
            return _json.dumps(_vo_durations(field, value, _write_duration_member))
    # field.enum carrying @intValueMap: the column is an INTEGER while the native
    # and wire contract stays the member SYMBOL (int-backing is a persistence-layer
    # concern, invisible above this codec), so encode symbol -> declared int here.
    #
    # An unmapped symbol is passed through untouched: membership is the column's
    # CHECK constraint to enforce, and inventing a value here would hide the drift.
    #
    # isArray=true (an ``integer[]`` column): encode ELEMENT-WISE, so the driver
    # binds a list of ints, never the symbol list. A null element stays a null
    # element (as in a string-backed enum array), and an unmapped element passes
    # through like the scalar does; an array column carries no CHECK, so the
    # database's integer[] type is what rejects it.
    if sub == fc.FIELD_SUBTYPE_ENUM:
        int_map = _int_value_map(field)
        if int_map is not None:
            if field_is_array(field) and isinstance(value, list):
                return [_encode_enum_member(int_map, v) for v in value]
            return _encode_enum_member(int_map, value)
        # rc.21: a @stringValueMap enum stores the member's string (scalar only; the
        # loader refuses it on an array).
        stored_map = _string_value_map(field)
        if stored_map is not None and isinstance(value, str):
            if value in stored_map:
                return stored_map[value]
            # An unmapped member raises, written or filtered (rc.21 rulings, every port). Written:
            # no CHECK need hold behind it (@dbCheck: false), and storing the symbol would write a
            # spelling the column does not hold. Filtered: passed through, the symbol could equal
            # ANOTHER member's stored string and match that member's rows.
            verb = "filter on" if for_filter else "write"
            raise ValueError(
                f"field.enum '{field.name}' cannot {verb} {value!r}: it has no stored string in "
                f"@{fc.FIELD_ATTR_STRING_VALUE_MAP} — the value is not one of the members the model declares."
            )

    # Everything else (string / int / long / double / float / boolean / enum)
    # is already the native type pg8000 binds directly.
    return value


def _write_duration_member(field: MetaField, value: Any) -> str:
    """A ``field.duration`` member of a value object, as the canonical string its JSON holds."""
    try:
        return format_duration(parse_duration_input(value))
    except ValueError as e:
        raise ValueError(f"field.duration '{field.name}' cannot be written: {e}") from None


def _read_duration_member(field: MetaField, value: Any) -> str:
    """A ``field.duration`` member of a stored value object, in its canonical form (a value
    another writer stored in an accepted but non-canonical spelling is normalised)."""
    try:
        return format_duration(duration_from_driver(value))
    except ValueError as e:
        raise ValueError(f"field.duration '{field.name}' read a stored value that is not one: {e}") from None


def _vo_has_duration(vo: MetaObject, seen: frozenset[int] = frozenset()) -> bool:
    """True when value object *vo*, or one it embeds, has a ``field.duration`` member."""
    if id(vo) in seen:
        return False
    seen = seen | {id(vo)}
    for f in vo.fields():
        if f.sub_type == fc.FIELD_SUBTYPE_DURATION:
            return True
        if f.sub_type in (fc.FIELD_SUBTYPE_OBJECT, fc.FIELD_SUBTYPE_MAP):
            target = ref_target(f, fc.FIELD_ATTR_OBJECT_REF)
            if isinstance(target, MetaObject) and _vo_has_duration(target, seen):
                return True
    return False


def _vo_durations(field: MetaField, value: Any, convert: Any, seen: frozenset[int] = frozenset()) -> Any:
    """The value of a jsonb ``field.object`` / ``field.map`` with *convert* applied to every
    ``field.duration`` member of its value object, at any depth: a single object, an array of
    them, the values of a map, and the value objects those embed. Anything that is not the
    shape the metadata declares is left as it is (validation reports it, not this)."""
    if value is None:
        return None
    target = ref_target(field, fc.FIELD_ATTR_OBJECT_REF)  # ADR-0039 resolving @objectRef
    if not isinstance(target, MetaObject) or id(target) in seen or not _vo_has_duration(target):
        return value
    seen = seen | {id(target)}

    def one(member: Any) -> Any:
        if not isinstance(member, Mapping):
            return member
        out = dict(member)
        for f in target.fields():
            v = out.get(f.name)
            if v is None:
                continue
            if f.sub_type == fc.FIELD_SUBTYPE_DURATION:
                out[f.name] = [None if x is None else convert(f, x) for x in v] if isinstance(v, list) else convert(f, v)
            elif f.sub_type in (fc.FIELD_SUBTYPE_OBJECT, fc.FIELD_SUBTYPE_MAP):
                out[f.name] = _vo_durations(f, v, convert, seen)
        return out

    if field.sub_type == fc.FIELD_SUBTYPE_MAP:
        return {k: one(v) for k, v in value.items()} if isinstance(value, Mapping) else value
    if isinstance(value, list):
        return [one(v) for v in value]
    return one(value)


def _duration_write_value(field: MetaField, value: Any) -> DurationParam:
    """The bound value of a ``field.duration``: a :class:`DurationParam`, so the dialect that
    binds a duration as text does so by the field, never by a value's type."""
    try:
        return DurationParam.of(parse_duration_input(value))
    except ValueError as e:
        raise ValueError(f"field.duration '{field.name}' cannot be written: {e}") from None


def _encode_enum_member(int_map: dict[Any, Any], member: Any) -> Any:
    """One member symbol as its declared int; ``None`` and an unmapped (or
    unhashable) value pass through untouched."""
    if isinstance(member, str) and member in int_map:
        return int_map[member]
    return member


def _int_value_map(field: MetaField) -> dict[Any, Any] | None:
    """The declared ``@intValueMap`` (symbol → int), or ``None`` when the enum is
    string-backed.

    ADR-0039 resolving: the map is ``@values``' numeric half — a logical property
    of the enum vocabulary that inherits through ``extends`` — so it is read with
    ``get_meta_attr``, NOT the own-only accessor (contrast ``@dbColumnType`` in
    :func:`coerce_write_value`, the one field attribute that is deliberately
    own-only). Shared by the write and read halves of the enum codec, mirroring
    the dedicated int-map helper each sibling port's codec keeps (Java
    ``EnumCodec.intValueMap``, Kotlin ``readIntValueMap``, C# ``IntValueMapOf``).
    """
    m = field.get_meta_attr(fc.FIELD_ATTR_INT_VALUE_MAP)
    return m if isinstance(m, dict) else None


def _string_value_map(field: MetaField) -> dict[str, str] | None:
    """rc.21 — the declared ``@stringValueMap`` (member → stored string), or ``None``.
    ADR-0039 resolving, as :func:`_int_value_map`."""
    m = field.get_meta_attr(fc.FIELD_ATTR_STRING_VALUE_MAP)
    return m if isinstance(m, dict) else None


def decode_read_value(field: MetaField, value: Any) -> Any:
    """Decode a stored value back to its authoring form on read.

    A ``field.duration`` reads back as a ``datetime.timedelta`` whatever the engine handed
    back (see the branch below). Beyond that, two cases. The inverse of
    :func:`coerce_write_value`'s int-backed-enum branch:
    the column holds the member's integer, callers expect the member SYMBOL. And
    ``field.currency``, whose native type is ``int`` minor units: a table column is
    BIGINT and already reads back as an ``int``, but a VIEW column need not be —
    ``SUM`` over BIGINT is Postgres ``numeric``, read back as a ``Decimal``, which a
    FastAPI route then serializes as a JSON STRING. An integral ``Decimal`` is
    decoded to ``int``; a fractional one (an ``avg`` over minor units) has no honest
    ``int`` and is returned as read. Every other field subtype is returned verbatim,
    keeping ADR-0019's "runtime returns native in-process types" contract intact.

    An int with no member RAISES. The database then holds a value the model says
    is impossible — a hand-written INSERT, or a member removed without a
    migration — and neither alternative is honest: returning the raw int hands
    the caller a "member" that is not one (C#, Kotlin and TypeScript type this
    property as a CLOSED enum, where ``7`` is not even representable), and
    returning ``None`` hides the corruption behind a nullable column. Every port
    throws here.
    """
    if value is None:
        return None
    if field.sub_type == fc.FIELD_SUBTYPE_DURATION:
        # A duration reads back as a datetime.timedelta on every engine: pg8000 hands one back
        # for an interval, a SQLite / MySQL integer column holds the microsecond count. An interval with a month
        # part (a PGInterval from pg8000, its text from psycopg: see PostgresDriver) is not a fixed length: refused.
        if isinstance(value, list):
            return [None if v is None else duration_from_driver(v) for v in value]
        return duration_from_driver(value)
    if field.sub_type in (fc.FIELD_SUBTYPE_OBJECT, fc.FIELD_SUBTYPE_MAP):
        # A jsonb value object's duration members read back in their canonical form.
        if field.get_meta_attr(fc.FIELD_ATTR_STORAGE) != "flattened":  # ADR-0039 resolving
            return _vo_durations(field, value, _read_duration_member)
        return value
    if field.sub_type == fc.FIELD_SUBTYPE_CURRENCY:
        if isinstance(value, _decimal.Decimal) and value == value.to_integral_value():
            return int(value)
        return value
    if field.sub_type != fc.FIELD_SUBTYPE_ENUM:
        return value
    int_map = _int_value_map(field)
    if int_map is None:
        stored_map = _string_value_map(field)
        if stored_map is not None and isinstance(value, str):
            # rc.21: the stored string back to its member; an unmapped one RAISES, as an
            # unmapped int does.
            for member, stored in stored_map.items():
                if stored == value:
                    return member
            raise ValueError(
                f"field.enum '{field.name}' read stored value {value!r} with no member in "
                f"@{fc.FIELD_ATTR_STRING_VALUE_MAP} (declared: {stored_map}) — the database holds "
                f"a value the model does not describe."
            )
        return value
    if isinstance(value, list):
        # isArray=true (``integer[]``): decode element-wise; a null element stays null.
        return [None if v is None else _decode_enum_int(field, int_map, v) for v in value]
    return _decode_enum_int(field, int_map, value)


def _decode_enum_int(field: MetaField, int_map: dict[Any, Any], value: Any) -> Any:
    """One stored int as its member symbol. A non-int is returned as read; an int
    with no member RAISES (see :func:`decode_read_value`)."""
    if not isinstance(value, int) or isinstance(value, bool):
        return value
    for symbol, stored in int_map.items():
        if stored == value:
            return symbol
    raise ValueError(
        f"field.enum '{field.name}' read stored value {value} with no member in "
        f"@{fc.FIELD_ATTR_INT_VALUE_MAP} (declared: {int_map}) — the database holds "
        f"a value the model does not describe."
    )


def decode_read_row(
    fields_by_name: dict[str, MetaField], row: dict[str, Any], dialect: Dialect = POSTGRES
) -> dict[str, Any]:
    """Apply the engine's storage decode, then :func:`decode_read_value`, to every
    field-keyed value in a mapped row."""
    return {
        k: (
            decode_read_value(fields_by_name[k], dialect.decode_value(fields_by_name[k], v))
            if k in fields_by_name
            else v
        )
        for k, v in row.items()
    }


# ----------------------------------------------------------------------------
# #203 — @autoSet CRUD stamping. A ``field.timestamp`` (or any temporal field)
# marked ``@autoSet: onCreate|onUpdate`` declares "the runtime owns this
# timestamp, the caller does not." create() stamps every onCreate AND onUpdate
# column; update() bumps onUpdate and NEVER rewrites onCreate (the lost-update
# guard); insert_preserving() writes them verbatim. The stamp is keyed off the
# COLUMN's temporal type (generalizes past ``datetime`` to date/time), matching
# the TS Zod-transform contract (server owns the value; a fresh row's updated
# timestamp equals its created one).
# ----------------------------------------------------------------------------

_AUTO_SET_TEMPORAL_SUBTYPES = (
    fc.FIELD_SUBTYPE_TIMESTAMP,
    fc.FIELD_SUBTYPE_DATE,
    fc.FIELD_SUBTYPE_TIME,
)


def read_fields(entity: MetaObject) -> list[MetaField]:
    """The fields a read selects. An entity that is not write-through reads its own table,
    which has no column for a derived (``origin.*``) field: an entity's primary source is
    always writable (the loader refuses a read-only primary). Every other object reads a view
    that carries them."""
    if entity.sub_type == OBJECT_SUBTYPE_ENTITY and not entity.is_write_through():
        return [f for f in entity.fields() if not f.is_derived()]
    return list(entity.fields())


def auto_set_fields(entity: MetaObject) -> tuple[list[MetaField], list[MetaField]]:
    """The entity's ``@autoSet`` temporal fields split into ``(onCreate, onUpdate)``.

    Reads the RESOLVING ``@autoSet`` (ADR-0039) so a field inherited from an
    abstract base — the common ``BaseEntity.createdAt/updatedAt`` pattern — is
    honored. A non-temporal field is skipped (``@autoSet`` is a temporal-only
    marker). Both lists are empty for an entity that declares no ``@autoSet``
    field, so the write path stays byte-identical for those entities."""
    on_create: list[MetaField] = []
    on_update: list[MetaField] = []
    for f in entity.fields():
        if f.sub_type not in _AUTO_SET_TEMPORAL_SUBTYPES:
            continue
        mode = f.get_meta_attr(fc.FIELD_ATTR_AUTO_SET)  # ADR-0039 resolving: may be inherited via extends
        if mode == fc.AUTO_SET_ON_CREATE:
            on_create.append(f)
        elif mode == fc.AUTO_SET_ON_UPDATE:
            on_update.append(f)
    return on_create, on_update


def auto_set_stamp(field: MetaField, base: _dt.datetime) -> Any:
    """The native ``now()`` value for an ``@autoSet`` *field*, derived from the
    single shared *base* instant so every column stamped in one operation is
    equal (a fresh row's created == updated). Keyed off the COLUMN's temporal
    type: ``field.date`` → ``date``; ``field.time`` → ``time``; ``field.timestamp``
    → a tz-aware ``datetime`` (the instant default) unless ``@localTime`` opts into
    a naive wall-clock value (matching :func:`coerce_write_value`)."""
    sub = field.sub_type
    if sub == fc.FIELD_SUBTYPE_DATE:
        return base.date()
    if sub == fc.FIELD_SUBTYPE_TIME:
        return base.time()
    # field.timestamp: instant / tz-aware by default; @localTime → naive wall clock.
    is_tz = field.get_meta_attr(dbc.FIELD_ATTR_LOCAL_TIME) is not True  # ADR-0039 resolving
    return base if is_tz else base.replace(tzinfo=None)


def _parse_datetime(text: str, *, tz_aware: bool) -> _dt.datetime:
    """Parse an ISO-8601 timestamp authoring string to a native datetime.

    A trailing ``Z`` (Zulu/UTC) is normalized to ``+00:00`` for ``fromisoformat``.
    For a TIMESTAMPTZ column we keep the resulting datetime tz-aware (defaulting
    an offset-less string to UTC); for a plain TIMESTAMP column we strip any
    offset to a naive wall-clock value so the driver binds ``timestamp`` (not
    ``timestamptz``).
    """
    iso = text[:-1] + "+00:00" if text.endswith("Z") else text
    dt = _dt.datetime.fromisoformat(iso)
    if tz_aware:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return dt
    # Naive wall clock: drop any offset without shifting (the wire form already
    # carried the intended wall-clock components).
    return dt.replace(tzinfo=None)


def column_of(field: MetaField | None, strategy: str = DEFAULT_COLUMN_NAMING) -> str:
    """Physical column for a field. Module-level shim over the shared
    :func:`metaobjects.naming.resolve_column_name` so the runtime and codegen cannot
    drift on what a column is called."""
    if field is None:
        return ""
    return resolve_column_name(field, strategy)
