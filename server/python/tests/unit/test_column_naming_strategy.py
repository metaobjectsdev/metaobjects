"""The column-naming strategy: how a field with no explicit ``@column`` becomes a
physical column name.

This port hardcoded ``literal`` — ``@column or field.name`` — in both the runtime and
codegen, with no way to select anything else. That is a break rather than a preference:
schema migrations are Node-owned (ADR-0015) and ``meta migrate`` defaults to
``snake_case``, so an entity with a multi-word field name produced runtime SQL against
``createdAt`` while the database column was ``created_at``. The byte-gated registry
prose for ``@column`` has always described the default as coming "via
columnNamingStrategy".

The DEFAULT stays ``literal`` — that is what this port already did, and an adopter whose
database matches it must not move.
"""
from __future__ import annotations

import pytest

from metaobjects.naming import (
    COLUMN_NAMING_KEBAB_CASE,
    COLUMN_NAMING_LITERAL,
    COLUMN_NAMING_SNAKE_CASE,
    DEFAULT_COLUMN_NAMING,
    apply_column_naming_strategy,
    resolve_column_name,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.shared.base_types import TYPE_FIELD


def _field(name: str, column: str | None = None) -> MetaField:
    f = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, name)
    if column is not None:
        f.set_attr(fc.FIELD_ATTR_COLUMN, column)
    return f


def test_default_is_literal_this_ports_historical_behaviour() -> None:
    assert DEFAULT_COLUMN_NAMING == COLUMN_NAMING_LITERAL
    assert resolve_column_name(_field("createdAt")) == "createdAt"


@pytest.mark.parametrize(
    ("strategy", "expected"),
    [
        (COLUMN_NAMING_LITERAL, "createdAt"),
        (COLUMN_NAMING_SNAKE_CASE, "created_at"),
        (COLUMN_NAMING_KEBAB_CASE, "created-at"),
    ],
)
def test_strategy_applies_to_a_field_with_no_column_attr(strategy: str, expected: str) -> None:
    assert resolve_column_name(_field("createdAt"), strategy) == expected


def test_an_explicit_column_attr_wins_over_every_strategy() -> None:
    # Deliberately NOT the snake_case of the field name, so "the strategy ran" and
    # "@column won" stay distinguishable.
    f = _field("callPurpose", column="purpose_code")
    for strategy in (COLUMN_NAMING_LITERAL, COLUMN_NAMING_SNAKE_CASE, COLUMN_NAMING_KEBAB_CASE):
        assert resolve_column_name(f, strategy) == "purpose_code"


def test_snake_case_matches_the_cross_port_algorithm() -> None:
    # Same cases the TS `toSnakeCase` and Kotlin `camelToSnake` pin, including the
    # acronym boundary — a port-local approximation here would put the two halves of
    # one schema out of step.
    assert apply_column_naming_strategy("displayName", COLUMN_NAMING_SNAKE_CASE) == "display_name"
    assert apply_column_naming_strategy("id", COLUMN_NAMING_SNAKE_CASE) == "id"
    assert apply_column_naming_strategy("userId", COLUMN_NAMING_SNAKE_CASE) == "user_id"
    assert apply_column_naming_strategy("URLPath", COLUMN_NAMING_SNAKE_CASE) == "url_path"


def test_an_unknown_strategy_is_refused_not_silently_defaulted() -> None:
    # A typo'd strategy would otherwise bind an entire schema to the wrong columns and
    # report success.
    with pytest.raises(ValueError, match="snake_case"):
        apply_column_naming_strategy("createdAt", "PascalCase")
