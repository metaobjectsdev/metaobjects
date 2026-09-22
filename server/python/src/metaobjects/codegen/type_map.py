"""Field-subtype → Python/Pydantic type mapping (sub-project A)."""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.codegen.value_objects import object_ref_class_name
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.persistence.db import db_constants as dbc


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
    # ADR-0036/0037 Wave 3 — field.uri binds Pydantic's AnyUrl (the idiomatic
    # native URL type; parses + validates scheme/authority/path — the Python
    # analogue of TS Zod z.string().url()). Wire/storage form stays a string;
    # DB column is text.
    fc.FIELD_SUBTYPE_URI: PyType("AnyUrl", ("from pydantic import AnyUrl",)),
    # ADR-0036/0037 Wave 3 — field.inet binds Pydantic's IPvAnyAddress (accepts
    # IPv4 + IPv6 — the Python analogue of TS Zod z.string().ip()). Wire/storage
    # form stays a string; DB column is the Postgres-native inet type.
    fc.FIELD_SUBTYPE_INET: PyType("IPvAnyAddress", ("from pydantic import IPvAnyAddress",)),
}


def field_is_array(field: MetaField) -> bool:
    """Effective array-ness (ADR-0039 resolving): the native ``is_array`` flag OR
    the ``@isArray`` attr, resolved through the ``extends`` super chain — a concrete
    field inheriting ``isArray:true`` from an abstract parent (whose flag lives on the
    parent as a native property, not an attr) must generate a ``list[...]``."""
    return field.resolved_is_array()


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
        ref_class = object_ref_class_name(field)
        if ref_class is not None:
            # The referenced model's emitted class name (ADR-0056: the value object's
            # own model, collision-qualified by the entity tier — mirrors the
            # field.object branch below).
            return PyType(f"dict[str, {ref_class}]")
        value_type = field.attrs().get(fc.FIELD_ATTR_VALUE_TYPE)
        value = _SCALAR.get(str(value_type), PyType("str")) if value_type else PyType("str")
        return PyType(f"dict[str, {value.expr}]", value.imports)
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        # The emitted models live flat in one generated package, so a field.object
        # types as the referenced model's class — resolved package-local (ADR-0042)
        # and collision-qualified for a value object (ADR-0044/0056), never the
        # ref's bare tail, which names the wrong class under a short-name collision.
        ref_class = object_ref_class_name(field)
        base = PyType(ref_class) if ref_class is not None else PyType("object")
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
    elif (
        field.sub_type in (fc.FIELD_SUBTYPE_URI, fc.FIELD_SUBTYPE_INET)
        and field.attrs().get(fc.FIELD_ATTR_LENIENT) is True
    ):
        # #234 — @lenient opts a field.uri / field.inet out of strict well-formedness:
        # bind a plain ``str`` (not Pydantic AnyUrl / IPvAnyAddress, whose construction
        # IS the validator) so a not-strictly-valid value round-trips unchanged.
        base = PyType("str")
    else:
        base = _SCALAR.get(field.sub_type, PyType("str"))
    if field_is_array(field):
        return PyType(f"list[{base.expr}]", base.imports)
    return base
