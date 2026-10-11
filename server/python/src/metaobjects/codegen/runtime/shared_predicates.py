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

import re

from metaobjects.codegen.instance_artifacts import emits_instance_artifacts
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


def has_literal_default(field: MetaField) -> bool:
    """True iff the read model gives *field* a Python default: a ``@default`` that is not a
    server-side SQL expression. Such a field is annotated ``T`` (not ``T | None``) with that
    default, so code that builds the model without a value for it must OMIT the keyword
    rather than pass ``None`` — the extractor's mapper relies on exactly this."""
    default_raw = field.attrs().get(fc.FIELD_ATTR_DEFAULT)
    return default_raw is not None and not is_sql_expr_default(default_raw)


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
