"""Tests for the #248 per-object physical database names generator.

One ``<entity_snake>_names.py`` per object with a declared (or inherited)
primary ``source.rdb``: module-level ``Final`` constants a hand-written
consumer references instead of a string literal. Mirrors the shipped C#
``NamesGenerator`` / ``CSharpNaming.ResolveObjectNames`` and the Kotlin
``KotlinNamesGenerator``.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects.cli import main
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.names_generator import (
    NamesGenerator,
    render_names,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import (
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_SCHEMA,
    SOURCE_KIND_VIEW,
    SOURCE_SUBTYPE_RDB,
)
from metaobjects.naming import resolve_column_name, to_snake_case
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_SOURCE


def _entity(
    name: str,
    fields: list[MetaField],
    *,
    source_kind: str | None = "table",
    schema: str | None = None,
    package: str | None = None,
) -> MetaObject:
    o = MetaObject(TYPE_OBJECT, "entity", name)
    o.package = package
    if source_kind is not None:
        src = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "")
        if source_kind != "table":
            src.set_attr(SOURCE_ATTR_KIND, source_kind)
        if schema is not None:
            src.set_attr(SOURCE_ATTR_SCHEMA, schema)
        o.add_child(src)
    for f in fields:
        o.add_child(f)
    return o


def _f(name: str, sub: str = fc.FIELD_SUBTYPE_STRING, *, column: str | None = None) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    if column is not None:
        f.set_attr(fc.FIELD_ATTR_COLUMN, column)
    return f


def test_emits_final_constants_for_table_and_columns() -> None:
    entity = _entity(
        "Subscriber",
        [
            _f("id", fc.FIELD_SUBTYPE_LONG),
            _f("email", fc.FIELD_SUBTYPE_STRING),
            _f("createdAt", fc.FIELD_SUBTYPE_TIMESTAMP),
        ],
        package="acme",
    )
    src = render_names(entity, "literal")
    assert src is not None
    assert 'SUBSCRIBER_KIND: Final[str] = "table"' in src
    # No @table declared -> step-4 fallback: pluralize(snake_case(entity.name)).
    assert 'SUBSCRIBER_NAME: Final[str] = "subscribers"' in src
    assert "SUBSCRIBER_READ_ONLY: Final[bool] = False" in src
    # A2: both names, always, always distinguished.
    assert 'SUBSCRIBER_CREATED_AT_FIELD: Final[str] = "createdAt"' in src
    # This port's default strategy is literal, matching ObjectManager.
    assert 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "createdAt"' in src
    # The map's values REFERENCE the constant, never repeat the literal.
    assert '"createdAt": SUBSCRIBER_CREATED_AT_COLUMN,' in src
    assert "SUBSCRIBER_COLUMNS_BY_FIELD: Final[dict[str, str]]" in src
    # Sorted by field name: createdAt < email < id.
    assert src.index("CREATED_AT_FIELD") < src.index("EMAIL_FIELD") < src.index("ID_FIELD")


def test_an_explicit_column_beats_the_strategy() -> None:
    # @column: "purpose_code" -- a re-derivation from the field name would say
    # "call_purpose".
    entity = _entity("Subscriber", [_f("callPurpose", column="purpose_code")])
    src = render_names(entity, "literal")
    assert src is not None
    assert 'SUBSCRIBER_CALL_PURPOSE_COLUMN: Final[str] = "purpose_code"' in src
    assert "call_purpose" not in src


def test_column_naming_now_reaches_the_generator() -> None:
    # The whole reason GenConfig.column_naming stops refusing.
    entity = _entity("Subscriber", [_f("createdAt", fc.FIELD_SUBTYPE_TIMESTAMP)])
    src = render_names(entity, "snake_case")
    assert src is not None
    assert 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "created_at"' in src
    assert 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "createdAt"' not in src


def test_gen_config_no_longer_refuses_a_non_default_strategy() -> None:
    GenConfig(out_dir="/tmp/x", column_naming="snake_case")  # must not raise


def test_gen_context_column_naming_reaches_the_generator() -> None:
    # Proves the WIRING, not just the pure render function: ctx.config.column_naming
    # (read as an attribute, at the point of use) must actually change what
    # NamesGenerator.generate() emits.
    entity = _entity("Subscriber", [_f("createdAt", fc.FIELD_SUBTYPE_TIMESTAMP)], package="acme")
    config = GenConfig(out_dir="/tmp/unused", column_naming="snake_case")
    ctx = GenContext(
        entities=[entity],
        loaded_root=None,
        matches=lambda _e: True,
        config=config,
        warn=lambda _msg: None,
    )
    files = NamesGenerator().generate(ctx)
    assert len(files) == 1
    assert files[0].path == "subscriber_names.py"
    assert 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "created_at"' in files[0].content


def test_absent_schema_omits_its_line() -> None:
    entity = _entity("Subscriber", [_f("id", fc.FIELD_SUBTYPE_LONG)])
    src = render_names(entity, "literal")
    assert src is not None
    # Never emitted as None / a blank literal -- omitted entirely.
    assert "_SCHEMA" not in src


def test_declared_schema_is_emitted() -> None:
    entity = _entity("Subscriber", [_f("id", fc.FIELD_SUBTYPE_LONG)], schema="reporting")
    src = render_names(entity, "literal")
    assert src is not None
    assert 'SUBSCRIBER_SCHEMA: Final[str] = "reporting"' in src


def test_read_only_kind_is_reflected() -> None:
    entity = _entity(
        "SubscriberSummary", [_f("id", fc.FIELD_SUBTYPE_LONG)], source_kind=SOURCE_KIND_VIEW
    )
    src = render_names(entity, "literal")
    assert src is not None
    assert 'SUBSCRIBERSUMMARY_KIND: Final[str] = "view"' in src
    assert "SUBSCRIBERSUMMARY_READ_ONLY: Final[bool] = True" in src


def test_no_primary_source_emits_nothing() -> None:
    # #248: participation derives from a declared source, never from the object
    # subtype -- an object.value (no source, ever) resolves to None here.
    entity = _entity("SubscriberBlurbPayload", [_f("text")], source_kind=None)
    assert render_names(entity, "literal") is None


def test_collision_guard_fires_naming_the_model() -> None:
    # "fooBar" and "foo_bar" both derive the constant member FOO_BAR.
    entity = _entity(
        "Weird",
        [_f("fooBar"), _f("foo_bar")],
    )
    with pytest.raises(ValueError) as exc_info:
        render_names(entity, "literal")
    msg = str(exc_info.value)
    assert "Weird" in msg
    assert "FOO_BAR" in msg
    assert "fooBar" in msg
    assert "foo_bar" in msg
    assert "@column" in msg


def test_the_artifact_agrees_with_the_runtime() -> None:
    # Python's generated code contains no physical name, so nothing downstream fails
    # when a constant is wrong. resolve_column_name is the only thing that names a
    # column (codegen AND runtime both call it); pin the artifact to it.
    entity = _entity(
        "Subscriber",
        [
            _f("createdAt", fc.FIELD_SUBTYPE_TIMESTAMP),
            _f("email", column="email_addr"),
            _f("id", fc.FIELD_SUBTYPE_LONG),
        ],
    )
    strategy = "snake_case"
    src = render_names(entity, strategy)
    assert src is not None
    for f in entity.fields():
        member = to_snake_case(f.name).upper()
        expected_column = resolve_column_name(f, strategy)
        assert f'SUBSCRIBER_{member}_COLUMN: Final[str] = "{expected_column}"' in src


_FITNESS_FIXTURE = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def _meta_dir(tmp_path: Path) -> str:
    d = tmp_path / "meta"
    d.mkdir()
    (d / "meta.fitness.json").write_text(_FITNESS_FIXTURE.read_text())
    return str(d)


def test_cli_column_naming_flag_reaches_the_generator(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    rc = main(["gen", meta_dir, "--out", str(out), "--column-naming", "snake_case"])
    assert rc == 0
    content = (out / "program_names.py").read_text()
    # priceCents has no explicit @column -> strategy-derived.
    assert 'PROGRAM_PRICE_CENTS_COLUMN: Final[str] = "price_cents"' in content
    # createdAt DOES declare @column: "created_ts" -> beats the strategy regardless.
    assert 'PROGRAM_CREATED_AT_COLUMN: Final[str] = "created_ts"' in content


def test_cli_column_naming_defaults_to_literal(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    rc = main(["gen", meta_dir, "--out", str(out)])
    assert rc == 0
    content = (out / "program_names.py").read_text()
    assert 'PROGRAM_PRICE_CENTS_COLUMN: Final[str] = "priceCents"' in content
