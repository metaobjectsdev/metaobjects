"""Field-subtype → Python/Pydantic type mapping (sub-project A)."""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.persistence.db import db_constants as dbc
from metaobjects.shared.structural import KEY_IS_ARRAY


@dataclass(frozen=True)
class PyType:
    expr: str                          # the annotation text, e.g. "str", "list[PostBrief]"
    imports: tuple[str, ...] = ()      # stdlib import lines this type needs


_SCALAR: dict[str, PyType] = {
    fc.FIELD_SUBTYPE_STRING: PyType("str"),
    fc.FIELD_SUBTYPE_INT: PyType("int"),
    fc.FIELD_SUBTYPE_LONG: PyType("int"),
    fc.FIELD_SUBTYPE_DOUBLE: PyType("float"),
    fc.FIELD_SUBTYPE_FLOAT: PyType("float"),
    fc.FIELD_SUBTYPE_BOOLEAN: PyType("bool"),
    fc.FIELD_SUBTYPE_DECIMAL: PyType("Decimal", ("from decimal import Decimal",)),
    fc.FIELD_SUBTYPE_CURRENCY: PyType("int"),  # integer minor units — wire contract
    fc.FIELD_SUBTYPE_DATE: PyType("datetime.date", ("import datetime",)),
    fc.FIELD_SUBTYPE_TIME: PyType("datetime.time", ("import datetime",)),
    fc.FIELD_SUBTYPE_TIMESTAMP: PyType("datetime.datetime", ("import datetime",)),
    # R6 Plan 2a — field.uuid binds the idiomatic native uuid.UUID (ADR-0001),
    # surfaced at build time. Wire/storage form stays a lowercase-canonical string.
    fc.FIELD_SUBTYPE_UUID: PyType("uuid.UUID", ("import uuid",)),
}


def field_is_array(field: MetaField) -> bool:
    """Array-ness from either form: the node property (programmatic build) or the
    `@isArray` attr (how metadata loads from JSON — the conformance-fixture form)."""
    return field.is_array or field.attrs().get(KEY_IS_ARRAY) is True


def _py_str_literal(value: str) -> str:
    """A double-quoted Python string literal (JSON-safe escaping) for embedding an
    enum member into a ``Literal[...]`` annotation — quote-style is stable across
    ruff formatting."""
    import json

    return json.dumps(str(value), ensure_ascii=False)


def effective_enum_values(field: MetaField) -> list[str]:
    """The string members of an enum field's ``@values`` — EFFECTIVE (own, else
    inherited via the ``extends`` super chain). A field that extends an abstract
    ``field.enum`` resolves the parent's ``@values`` here, mirroring the TS
    ``enumValues`` (which reads the effective attr). Empty when absent."""
    v = field.attrs().get(fc.FIELD_ATTR_VALUES)
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return []


def py_type_for(field: MetaField) -> PyType:
    """The (non-optional) Python annotation for a field, wrapping arrays in list[...].

    A ``field.enum`` with effective ``@values`` types as ``Literal[...]`` (value-
    constrained, Pydantic runtime-validated) rather than bare ``str``; an enum array
    becomes ``list[Literal[...]]``. An enum WITHOUT declared values falls back to
    ``str``."""
    if field.sub_type == fc.FIELD_SUBTYPE_MAP:
        # field.map → dict[str, V]. Keys are always strings; V is a value-object
        # (@objectRef → bare class name) or a scalar (@valueType, defaulting to
        # str). A map is stored as a single jsonb/object column and is NEVER
        # wrapped in list[...] (isArray does not apply), so return directly.
        ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
        if ref:
            # @objectRef is expanded to a package-qualified FQN at load time; the
            # emitted VOs live flat in one generated package, so type by the bare
            # class name (mirrors the field.object branch below).
            return PyType(f"dict[str, {str(ref).split('::')[-1]}]")
        value_type = field.attrs().get(fc.FIELD_ATTR_VALUE_TYPE)
        value = _SCALAR.get(str(value_type), PyType("str")) if value_type else PyType("str")
        return PyType(f"dict[str, {value.expr}]", value.imports)
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
        # @objectRef is expanded to a package-qualified FQN at load time
        # (e.g. ``app::pkg::Thing``); the emitted VOs all live flat in one
        # generated package, so type by the bare class name.
        base = PyType(str(ref).split("::")[-1]) if ref else PyType("object")
    elif field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        values = effective_enum_values(field)
        if values:
            # Double-quoted members so the annotation reads identically whether or not
            # the emitted module is ruff-formatted (ruff normalizes to double quotes).
            members = ", ".join(_py_str_literal(v) for v in values)
            base = PyType(f"Literal[{members}]", ("from typing import Literal",))
        else:
            base = PyType("str")
    elif (
        field.sub_type == fc.FIELD_SUBTYPE_STRING
        and field.attrs().get(dbc.FIELD_ATTR_DB_COLUMN_TYPE) == dbc.DB_COLUMN_TYPE_JSONB
    ):
        # Issue #98 — a field.string carrying @dbColumnType:jsonb is the escape hatch
        # for a genuinely-open JSON column (ADR-0013). pg8000 auto-decodes a jsonb
        # column to a native Python object (dict/list/scalar) at read time, so a `str`
        # annotation is a type lie. Bind ``Any`` — the Python analogue of TS's
        # z.unknown() (#97) — since jsonb can hold any JSON value. (Other ports whose
        # drivers return jsonb as raw text correctly keep their string type.)
        base = PyType("Any", ("from typing import Any",))
    else:
        base = _SCALAR.get(field.sub_type, PyType("str"))
    if field_is_array(field):
        return PyType(f"list[{base.expr}]", base.imports)
    return base
