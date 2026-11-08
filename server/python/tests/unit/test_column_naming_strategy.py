"""The column-naming strategy: how a field with no explicit ``@column`` becomes a
physical column name.

This port used to hardcode ``literal`` — ``@column or field.name`` — in both the
runtime and codegen, with no way to select anything else. That was a break rather than
a preference: schema migrations are Node-owned (ADR-0015) and ``meta migrate`` defaults
to ``snake_case``, so an entity with a multi-word field name produced runtime SQL
against ``createdAt`` while the database column was ``created_at``.

ADR-0058 (1.1.0) made naming ONE project setting (``naming`` in
``.metaobjects/config.json``, read by every port from the loaded root) and FLIPPED the
default to ``snake_case`` — what ``meta migrate`` has always created — in every port,
this one included. An adopter whose database genuinely has literal column names adds
``"naming": { "columns": "literal" }``.
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


def test_default_is_snake_case_adr_0058() -> None:
    assert DEFAULT_COLUMN_NAMING == COLUMN_NAMING_SNAKE_CASE
    # A hand-built field with no loaded root resolves `naming_rules_of`'s own
    # defaults — same answer as a project that declares no `naming` block at all.
    assert resolve_column_name(_field("createdAt")) == "created_at"


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
        apply_column_naming_strategy("createdAt", "camelCase")


# WHERE THE STRATEGY ACTUALLY REACHES, in this port.
#
# `GenConfig.column_naming` used to exist with NOTHING reading it — `grep -rn
# "\.column_naming"` over `src/` returned zero hits — so `GenConfig(column_naming=
# "snake_case")` ran clean, reported success and changed not one byte of generated
# output. It was named in docs/features/field-types.md as this port's codegen lever,
# which made a knob that could never work look like the answer. `GenConfig.__post_init__`
# REFUSED any non-default value rather than silently accepting it.
#
# The `names` generator (codegen/generators/names_generator.py) gave the field a real
# reader: one per-object `<entity>_names.py` module of physical database name constants,
# default-ON, reading `ctx.config.column_naming` for any field with no explicit
# `@column`. The refusal is gone — a non-default strategy now changes emitted output
# instead of raising. See test_names_generator.py for the generator's own coverage
# (explicit @column still wins, the collision guard, absent-schema omission, ...); this
# just pins that GenConfig itself no longer refuses.
def test_a_codegen_column_naming_strategy_is_no_longer_refused() -> None:
    from metaobjects.codegen.config import GenConfig

    # The default still constructs — nothing existing changes.
    assert GenConfig(out_dir="").column_naming == DEFAULT_COLUMN_NAMING

    # Every strategy now constructs cleanly — the `names` generator is the reader.
    for strategy in (COLUMN_NAMING_LITERAL, COLUMN_NAMING_SNAKE_CASE, COLUMN_NAMING_KEBAB_CASE):
        assert GenConfig(out_dir="", column_naming=strategy).column_naming == strategy


def test_object_manager_column_naming_argument_is_refused() -> None:
    """ADR-0058 Decision 4: the 1.0 runtime setter is refused with the shared message, before
    the manager touches its driver, so the value it held is never silently dropped."""
    from metaobjects.runtime.object_manager import ObjectManager

    with pytest.raises(ValueError) as excinfo:
        ObjectManager(None, driver=None, column_naming="literal")  # type: ignore[arg-type]
    assert str(excinfo.value) == (
        'ObjectManager(column_naming=...) was removed in 1.1.0. Column and table naming is one '
        'project setting now, read by every port: "naming" in .metaobjects/config.json, for '
        'example "naming": { "columns": "literal" }. Move it there and delete '
        "ObjectManager(column_naming=...). See "
        "https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/features/migrations/physical-naming.md"
    )


def test_pascal_keeps_a_first_character_whose_upper_case_is_not_one_character() -> None:
    """JavaScript and Python upper-case ``ß`` to "SS"; C# and Java keep it. Every port keeps it."""
    from metaobjects.naming import to_pascal_column

    assert to_pascal_column("requestURL") == "RequestURL"
    assert to_pascal_column("npi") == "Npi"
    assert to_pascal_column("ßeta") == "ßeta"
    assert to_pascal_column("") == ""


def test_every_built_in_is_a_registered_strategy() -> None:
    from metaobjects.naming import (
        BUILTIN_COLUMN_NAMING_STRATEGIES,
        BUILTIN_TABLE_NAMING_RULES,
        apply_column_naming_strategy,
        column_naming_strategy,
        table_naming_rule,
    )

    assert list(BUILTIN_COLUMN_NAMING_STRATEGIES) == ["snake_case", "literal", "kebab-case", "pascal"]
    assert list(BUILTIN_TABLE_NAMING_RULES) == ["snake_case", "literal"]
    assert apply_column_naming_strategy("requestURL", "pascal") == "RequestURL"
    assert column_naming_strategy("snake_case")("requestURL") == "request_url"
    assert table_naming_rule("literal")("OrderItem") == "OrderItem"


def test_an_application_strategy_wraps_a_built_in() -> None:
    from metaobjects.naming import (
        apply_column_naming_strategy,
        apply_table_naming_rule,
        column_naming_strategy,
        register_column_naming_strategy,
        register_table_naming_rule,
        registered_column_naming_strategies,
        registered_table_naming_rules,
        table_naming_rule,
    )

    pascal = column_naming_strategy("pascal")
    register_column_naming_strategy("py-test-acronyms", lambda n: "NPI" if n == "npi" else pascal(n))
    register_table_naming_rule("py-test-prefixed", lambda n: "t_" + table_naming_rule("snake_case")(n))
    assert apply_column_naming_strategy("npi", "py-test-acronyms") == "NPI"
    assert apply_column_naming_strategy("createdAt", "py-test-acronyms") == "CreatedAt"
    assert apply_table_naming_rule("OrderItem", "py-test-prefixed") == "t_order_item"
    assert "py-test-acronyms" in registered_column_naming_strategies()
    assert "py-test-acronyms" not in registered_table_naming_rules()


def test_a_built_in_cannot_be_replaced() -> None:
    from metaobjects.naming import register_column_naming_strategy, register_table_naming_rule

    with pytest.raises(ValueError, match="built in"):
        register_column_naming_strategy("snake_case", lambda n: n)
    with pytest.raises(ValueError, match="built in"):
        register_table_naming_rule("literal", lambda n: n)


def test_an_unknown_name_fails_loud_naming_the_strategy_and_the_port() -> None:
    from metaobjects.naming import UnknownNamingStrategyError, column_naming_strategy, table_naming_rule

    with pytest.raises(UnknownNamingStrategyError) as raised:
        column_naming_strategy("no-such-rule")
    message = str(raised.value)
    assert '"naming.columns" names "no-such-rule"' in message
    assert "Python port" in message
    assert "built in: snake_case, literal, kebab-case, pascal" in message
    with pytest.raises(UnknownNamingStrategyError):
        table_naming_rule("pascal")
