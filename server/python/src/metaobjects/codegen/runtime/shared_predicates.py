"""Predicates more than one generator asks, in one module no generator owns.

`metaobjects eject` copies a generator into the adopter's repo and wires it in beside the
packaged ones. A generator that imported one of these from ANOTHER generator's module
would, in an owned copy, keep calling the packaged copy of that other generator, so an
edit to the owned one would never be seen. Both predicates therefore live here.

They are emit rules, so eject hands them over with the generator. Every generator that
needs one imports it relatively, from its ``runtime`` sibling
(``from ..runtime.shared_predicates import ...``), and lists this module in its registry
entry's ``runtime``. Eject copies it to ``codegen/runtime/shared_predicates.py``, and the
same import in an owned generator (``codegen/generators/``) then resolves to that copy:
owned generators agree with each other and never read the installed one.
``tests/codegen/test_eject_independence.py`` runs both halves.

Unlike ``filter_parser`` and ``constraint_errors``, no GENERATED code imports this module:
it runs at ``gen`` time only, which is why it may import ``metaobjects``.
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Callable

from metaobjects.codegen.generators.tph_plan import is_tph_subtype
from metaobjects.codegen.instance_artifacts import emits_instance_artifacts
from metaobjects.codegen.type_map import field_is_array
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.source_constants import (
    SOURCE_KIND_MATERIALIZED_VIEW,
    SOURCE_KIND_TABLE,
    SOURCE_KIND_VIEW,
)
from metaobjects.source_resolution import primary_rdb_source


# SQL expression defaults: anything matching is a SERVER-side default (the DB fills
# it), NOT a Python literal default — so `@default: gen_random_uuid()` must not emit
# `id: uuid.UUID = "gen_random_uuid()"`. Mirrors the TS column-mapper's
# SQL_EXPR_PATTERNS (and migrate-ts EXPR_DEFAULT_PATTERNS) so every port agrees on
# what counts as an expression.
SQL_EXPR_DEFAULT_PATTERNS = (
    re.compile(r"^now$", re.I),
    re.compile(r"^now\(\)$", re.I),
    re.compile(r"^current_timestamp$", re.I),
    re.compile(r"^current_date$", re.I),
    re.compile(r"^current_time$", re.I),
    re.compile(r"\(\)$"),  # anything function-like, e.g. gen_random_uuid()
)


def is_sql_expr_default(value: object) -> bool:
    """True iff *value* is a server-side SQL expression default (DB-filled), not a
    Python literal. Only string defaults can be expressions."""
    return isinstance(value, str) and any(p.search(value) for p in SQL_EXPR_DEFAULT_PATTERNS)


def _parse_bool_element(raw: object) -> bool:
    text = str(raw).lower()
    if text not in ("true", "false"):
        raise ValueError(raw)
    return text == "true"


def _parse_text_element(raw: object) -> str:
    """A string, or a JSON number or boolean read as its text. null and a nested value are
    refused."""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, bool | int | float):
        return json.dumps(raw)
    raise ValueError(raw)


def _parse_float_element(raw: object) -> float:
    """float() also reads ``nan`` and ``inf``, whose repr is not Python source."""
    value = float(str(raw))
    if not math.isfinite(value):
        raise ValueError(raw)
    return value


# How an array @default's non-empty elements read in Python, per element subtype. A subtype
# with no entry has no Python spelling here, so its array default stays with the database.
_ARRAY_ELEMENT_PARSERS: dict[str, Callable[[object], object]] = {
    fc.FIELD_SUBTYPE_STRING: _parse_text_element,
    fc.FIELD_SUBTYPE_INT: lambda v: int(str(v)),
    fc.FIELD_SUBTYPE_LONG: lambda v: int(str(v)),
    fc.FIELD_SUBTYPE_DOUBLE: _parse_float_element,
    fc.FIELD_SUBTYPE_FLOAT: _parse_float_element,
    fc.FIELD_SUBTYPE_BOOLEAN: _parse_bool_element,
}


def array_default(field: MetaField) -> list[object] | None:
    """The list an array field's ``@default`` spells, or None when it is not one this can
    read. The metadata value is always a string — ``{}``, ``[]``, ``{a,b}`` or ``["a","b"]``
    — and the same four shapes the TS column-mapper's parseArrayDefault accepts are read
    here, with the same refusals: a quote or nested brace in the Postgres form is an
    escaping shape neither port models."""
    raw = field.attrs().get(fc.FIELD_ATTR_DEFAULT)
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    elements: list[object]
    if text.startswith("[") and text.endswith("]"):
        try:
            elements = json.loads(text)
        except ValueError:
            return None
        if not isinstance(elements, list):
            return None
    elif text.startswith("{") and text.endswith("}"):
        inner = text[1:-1].strip()
        if re.search(r'["{}]', inner):
            return None
        elements = [p.strip() for p in inner.split(",")] if inner else []
    else:
        return None
    if not elements:
        return []
    parse = _ARRAY_ELEMENT_PARSERS.get(field.sub_type)
    if parse is None:
        return None
    try:
        return [parse(e) for e in elements]
    except ValueError:
        return None


def has_literal_default(field: MetaField) -> bool:
    """True iff the read model gives *field* a Python default: a ``@default`` that is not a
    server-side SQL expression (nor an array default Python cannot spell). Such a field is
    annotated ``T`` (not ``T | None``) with that default, so code that builds the model
    without a value for it must OMIT the keyword rather than pass ``None`` — the extractor's
    mapper relies on exactly this."""
    default_raw = field.attrs().get(fc.FIELD_ATTR_DEFAULT)
    if default_raw is None or is_sql_expr_default(default_raw):
        return False
    return not field_is_array(field) or array_default(field) is not None


# F22 — the read-only source kinds that still get a REST surface. A view (and a
# materialized view) is a collection of rows addressable by the identity the
# projection inherits, which is exactly the shape a collection-and-item REST
# resource needs. `storedProc` / `tableFunction` are invocations, not collections:
# they have no such shape and stay skipped, as they are for the writable router.
READ_ONLY_ROUTED_KINDS = frozenset({SOURCE_KIND_VIEW, SOURCE_KIND_MATERIALIZED_VIEW})


def emits_router(entity: MetaObject) -> bool:
    """Whether this object gets a generated router — writable CRUD or read-only.

    THE single source of truth for the router emit set, exported so
    ``filter_allowlist_generator`` can gate on the same answer instead of a
    second copy of the rule. The generated router does ``from
    .<snake>_filter_allowlist import ...``, so an allowlist emitted for a
    different set than the routers is not a cosmetic mismatch — the module is
    missing at import and the app fails to start. That failure mode is already
    recorded in this codebase for the write-through case; keeping two copies of
    the predicate is what let it happen, so there is now one.
    """
    if not emits_instance_artifacts(entity):
        return False
    src = primary_rdb_source(entity)
    if src is None:
        return False
    kind = src.effective_kind()
    return (
        entity.is_write_through()
        or kind == SOURCE_KIND_TABLE
        or kind in READ_ONLY_ROUTED_KINDS
    )


def is_read_only_routed(entity: MetaObject) -> bool:
    """Whether the router generator chooses the READ-ONLY router for this object (a view /
    materialized-view source that is not write-through): GET list, GET by id when it has an
    item route, and the 405 refusals, with no write surface.

    THE predicate behind that choice, shared with the API-docs generator so a page can never
    present write verbs for an object whose router refuses them."""
    if not emits_router(entity) or entity.is_write_through():
        return False
    src = primary_rdb_source(entity)
    return src is not None and src.effective_kind() in READ_ONLY_ROUTED_KINDS


def emits_writable_router(entity: MetaObject) -> bool:
    """Whether the router generator emits the full CRUD router for this object: it gets a
    router, that router is not the read-only one, and it is not a table-per-hierarchy subtype
    (a subtype is folded into its base's single table, so its CRUD lives under the base).

    THE predicate behind that choice, shared with the API-docs generator so a page can never
    document write routes for an object the router does not give them."""
    return (
        emits_router(entity)
        and not is_read_only_routed(entity)
        and not is_tph_subtype(entity)
    )
