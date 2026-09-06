"""Tests for the #248 per-object physical database names generator.

One ``<entity_snake>_names.py`` per object with a declared (or inherited)
primary ``source.rdb``: module-level ``Final`` constants a hand-written
consumer references instead of a string literal. Mirrors the shipped C#
``NamesGenerator`` / ``CSharpNaming.ResolveObjectNames`` and the Kotlin
``KotlinNamesGenerator``.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.cli import main
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.generators.names_generator import (
    NamesGenerator,
    names_generator,
    render_names,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.core.identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_PRIMARY,
    IDENTITY_SUBTYPE_REFERENCE,
    IDENTITY_SUBTYPE_SECONDARY,
)
from metaobjects.meta.core.index.index_constants import (
    INDEX_ATTR_FIELDS,
    INDEX_SUBTYPE_LOOKUP,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.persistence.source.source_constants import (
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_ROLE,
    SOURCE_ATTR_SCHEMA,
    SOURCE_ATTR_TABLE,
    SOURCE_ATTR_VIEW,
    SOURCE_KIND_VIEW,
    SOURCE_ROLE_REPLICA,
    SOURCE_SUBTYPE_RDB,
)
from metaobjects.naming import resolve_column_name, to_snake_case
from metaobjects.shared.base_types import (
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_INDEX,
    TYPE_OBJECT,
    TYPE_SOURCE,
)


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
    # The object's OWN identity — `_NAME` is the metamodel name, NOT the table.
    assert 'SUBSCRIBER_TYPE: Final[str] = "object"' in src
    assert 'SUBSCRIBER_SUB_TYPE: Final[str] = "entity"' in src
    assert 'SUBSCRIBER_NAME: Final[str] = "Subscriber"' in src
    # ...and the physical name sits under the member named for the source's @kind,
    # keyed by the role the source plays.
    assert 'SUBSCRIBER_SOURCE_PRIMARY_TYPE: Final[str] = "source"' in src
    assert 'SUBSCRIBER_SOURCE_PRIMARY_SUB_TYPE: Final[str] = "rdb"' in src
    assert 'SUBSCRIBER_SOURCE_PRIMARY_KIND: Final[str] = "table"' in src
    # No @table declared -> step-4 fallback: pluralize(snake_case(entity.name)).
    assert 'SUBSCRIBER_SOURCE_PRIMARY_TABLE: Final[str] = "subscribers"' in src
    # A derivation over @kind, never declared, read by nothing in any port.
    assert "READ_ONLY" not in src
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
    assert 'SUBSCRIBER_SOURCE_PRIMARY_SCHEMA: Final[str] = "reporting"' in src


def test_a_view_source_carries_its_name_under_the_view_member_not_table() -> None:
    """The half of the restructure that earns it: one member cannot hold a table, a
    view and a stored procedure and still mean something. The member says what the
    thing IS, so a reader does not consult a second constant to find out.
    """
    entity = _entity(
        "SubscriberSummary", [_f("id", fc.FIELD_SUBTYPE_LONG)], source_kind=SOURCE_KIND_VIEW
    )
    src = render_names(entity, "literal")
    assert src is not None
    assert 'SUBSCRIBERSUMMARY_SOURCE_PRIMARY_KIND: Final[str] = "view"' in src
    assert 'SUBSCRIBERSUMMARY_SOURCE_PRIMARY_VIEW: Final[str] = "subscriber_summaries"' in src
    # Stated in the negative too: a view must not also be spelled as a table.
    assert "SUBSCRIBERSUMMARY_SOURCE_PRIMARY_TABLE" not in src
    # READ_ONLY is a derivation over @kind, not metadata. The reader asks KIND.
    assert "READ_ONLY" not in src


def test_a_write_through_entity_carries_both_physical_names_under_their_roles() -> None:
    """The slot the flat shape did not have. A write-through entity declares TWO
    physical names — it writes to a table and reads through a replica view — and the
    module carried one; keying sources by effective ``@role`` is what gives the view
    a home.
    """
    entity = MetaObject(TYPE_OBJECT, "entity", "Ledger")
    primary = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "")
    primary.set_attr(SOURCE_ATTR_TABLE, "tbl_ldg_entry")
    replica = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "")
    replica.set_attr(SOURCE_ATTR_KIND, SOURCE_KIND_VIEW)
    replica.set_attr(SOURCE_ATTR_VIEW, "v_ldg_entry_ro")
    replica.set_attr(SOURCE_ATTR_ROLE, SOURCE_ROLE_REPLICA)
    entity.add_child(primary)
    entity.add_child(replica)
    entity.add_child(_f("id", fc.FIELD_SUBTYPE_LONG))

    src = render_names(entity, "literal")
    assert src is not None
    assert 'LEDGER_SOURCE_PRIMARY_TABLE: Final[str] = "tbl_ldg_entry"' in src
    assert 'LEDGER_SOURCE_REPLICA_VIEW: Final[str] = "v_ldg_entry_ro"' in src
    assert 'LEDGER_SOURCE_REPLICA_KIND: Final[str] = "view"' in src


def _identity(sub_type: str, name: str, fields: str) -> MetaData:
    node = MetaData(TYPE_IDENTITY, sub_type, name)
    node.set_attr(IDENTITY_ATTR_FIELDS, fields)
    return node


def test_identities_and_indexes_carry_type_subtype_and_name() -> None:
    entity = _entity("Customer", [_f("email"), _f("status")])
    entity.add_child(_identity(IDENTITY_SUBTYPE_PRIMARY, "pk", "email"))
    entity.add_child(_identity(IDENTITY_SUBTYPE_SECONDARY, "uq_cust_email", "email"))
    lookup = MetaData(TYPE_INDEX, INDEX_SUBTYPE_LOOKUP, "ix_cust_status")
    lookup.set_attr(INDEX_ATTR_FIELDS, "status")
    entity.add_child(lookup)

    src = render_names(entity, "literal")
    assert src is not None
    # subType is load-bearing, not decorative: it is the ONLY thing distinguishing a
    # unique alternate key from a non-unique lookup index (ADR-0040).
    assert 'CUSTOMER_IDENTITY_UQ_CUST_EMAIL_SUB_TYPE: Final[str] = "secondary"' in src
    assert 'CUSTOMER_INDEX_IX_CUST_STATUS_SUB_TYPE: Final[str] = "lookup"' in src
    assert 'CUSTOMER_IDENTITY_UQ_CUST_EMAIL_NAME: Final[str] = "uq_cust_email"' in src
    assert 'CUSTOMER_INDEX_IX_CUST_STATUS_NAME: Final[str] = "ix_cust_status"' in src


def test_only_secondary_and_lookup_carry_a_database_index_name() -> None:
    """Stated in the negative as well, because the absent half is the ruling.

    ``identity.primary`` has no database name to carry: migrate hardcodes
    ``<table>_pkey`` on Postgres, emits an unnamed PK on SQLite, and no port's codegen
    names a primary key at all. Carrying one would restate a migrate-only,
    dialect-conditional formula in an artifact whose promise is that a name is spelled
    once — the defect the artifact exists to prevent, re-created by the mechanism built
    to prevent it. ``identity.reference``'s name is an addressing handle, not a
    constraint name.
    """
    entity = _entity("Customer", [_f("email"), _f("ownerId")])
    entity.add_child(_identity(IDENTITY_SUBTYPE_PRIMARY, "pk", "email"))
    entity.add_child(_identity(IDENTITY_SUBTYPE_SECONDARY, "uq_cust_email", "email"))
    ref = MetaData(TYPE_IDENTITY, IDENTITY_SUBTYPE_REFERENCE, "ownerRef")
    ref.set_attr(IDENTITY_ATTR_FIELDS, "ownerId")
    ref.set_attr(IDENTITY_REFERENCE_ATTR_REFERENCES, "Owner")
    entity.add_child(ref)

    src = render_names(entity, "literal")
    assert src is not None
    assert 'CUSTOMER_IDENTITY_UQ_CUST_EMAIL_INDEX: Final[str] = "uq_cust_email"' in src
    assert "CUSTOMER_IDENTITY_PK_INDEX" not in src
    assert "CUSTOMER_IDENTITY_OWNER_REF_INDEX" not in src


def test_an_index_lookup_with_an_empty_name_is_refused() -> None:
    """The loader accepts it — an ``index.lookup`` is not addressable by a dotted
    ``extends`` ref, so it carries none of the FR-024 name check an ``identity.*``
    does — and it would reach an emitter as ``index("")``. ``resolve_index_name`` is
    the shared door that refuses it, so the module and any DDL cannot disagree about
    what an index is called.
    """
    entity = _entity("Customer", [_f("status")])
    entity.add_child(MetaData(TYPE_INDEX, INDEX_SUBTYPE_LOOKUP, ""))
    with pytest.raises(ValueError, match="empty name"):
        render_names(entity, "literal")


def test_the_type_prefix_keeps_a_default_named_primary_key_off_the_primary_source() -> None:
    """``identity.primary`` carries ``defaultName: "primary"`` (spec/metamodel/
    identity.json), and a source's role key is also ``primary``. Without the type
    prefix both want ``<ENTITY>_PRIMARY_*`` and the later assignment silently wins —
    the module would hand back an identity's subType for a question about the table.
    """
    entity = _entity("Customer", [_f("email")])
    entity.add_child(_identity(IDENTITY_SUBTYPE_PRIMARY, "primary", "email"))

    src = render_names(entity, "literal")
    assert src is not None
    assert 'CUSTOMER_SOURCE_PRIMARY_SUB_TYPE: Final[str] = "rdb"' in src
    assert 'CUSTOMER_IDENTITY_PRIMARY_SUB_TYPE: Final[str] = "primary"' in src
    # Each is defined exactly once: a collapse would have left one of them missing.
    assert src.count("CUSTOMER_SOURCE_PRIMARY_SUB_TYPE: Final") == 1
    assert src.count("CUSTOMER_IDENTITY_PRIMARY_SUB_TYPE: Final") == 1


def test_the_collision_guard_spans_collections_naming_both_nodes() -> None:
    """Whole emitted member set, never per collection. An identity and an index whose
    author-chosen names fold to the same member land in the SAME module, so the later
    assignment would silently win.
    """
    entity = _entity("Customer", [_f("email"), _f("status")])
    entity.add_child(_identity(IDENTITY_SUBTYPE_SECONDARY, "byThing", "email"))
    lookup = MetaData(TYPE_INDEX, INDEX_SUBTYPE_LOOKUP, "by_thing")
    lookup.set_attr(INDEX_ATTR_FIELDS, "status")
    entity.add_child(lookup)
    # Different TYPES, so the prefix keeps them apart — this must NOT raise.
    assert render_names(entity, "literal") is not None

    clash = _entity("Customer", [_f("email"), _f("status")])
    clash.add_child(_identity(IDENTITY_SUBTYPE_SECONDARY, "byThing", "email"))
    clash.add_child(_identity(IDENTITY_SUBTYPE_SECONDARY, "by_thing", "status"))
    with pytest.raises(ValueError) as exc_info:
        render_names(clash, "literal")
    msg = str(exc_info.value)
    assert "byThing" in msg
    assert "by_thing" in msg
    assert "CUSTOMER_IDENTITY_BY_THING" in msg


def test_an_index_name_that_is_not_an_identifier_is_folded_not_dropped() -> None:
    """A dict key can be quoted; a module-level constant cannot. ``2fa-idx`` folds to
    ``2FA_IDX`` — and the constant still starts with the entity prefix, so it stays a
    legal identifier. The emitted module has to be importable, so assert it compiles.
    """
    entity = _entity("Customer", [_f("status")])
    lookup = MetaData(TYPE_INDEX, INDEX_SUBTYPE_LOOKUP, "2fa-idx")
    lookup.set_attr(INDEX_ATTR_FIELDS, "status")
    entity.add_child(lookup)

    src = render_names(entity, "literal")
    assert src is not None
    assert 'CUSTOMER_INDEX_2FA_IDX_INDEX: Final[str] = "2fa-idx"' in src
    compile(src, "<names>", "exec")


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


def test_verify_codegen_with_matching_column_naming_is_clean(tmp_path: Path, capsys) -> None:
    """R31 — `verify --codegen` must accept `--column-naming` and thread it into its
    OWN regen. `gen --column-naming snake_case` emits `names` constants under that
    strategy; a `verify --codegen` blind to the flag would regenerate under the
    `literal` default and convict every `<ENTITY>_<FIELD>_COLUMN` constant as drift —
    the exact "gate fails work the product itself sanctions" pattern this project's
    own CHANGELOG names as a defect class. Passing the SAME strategy must report
    clean.
    """
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out), "--column-naming", "snake_case"]) == 0

    capsys.readouterr()  # discard `gen`'s own stdout
    rc = main(
        ["verify", meta_dir, "--codegen", "--out", str(out), "--column-naming", "snake_case"]
    )
    captured = capsys.readouterr()
    assert rc == 0, captured.err
    assert "in sync" in captured.out


def test_verify_codegen_with_mismatched_column_naming_reports_drift(tmp_path: Path, capsys) -> None:
    """The discriminating half of the pair: a `verify --codegen` that silently
    ignored `--column-naming` (or never threaded it into its regen) would also
    pass the clean-case test above — only a MISMATCHED strategy proves the flag is
    actually read rather than merely accepted by argparse.
    """
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out), "--column-naming", "snake_case"]) == 0

    capsys.readouterr()
    rc = main(
        ["verify", meta_dir, "--codegen", "--out", str(out), "--column-naming", "literal"]
    )
    captured = capsys.readouterr()
    assert rc == 1
    assert "drifted:" in captured.err
    assert "program_names.py" in captured.err


def test_an_author_supplied_field_name_with_a_quote_is_escaped_in_columns_by_field(
    tmp_path: Path,
) -> None:
    # Every literal in the module goes through `_q` except the COLUMNS_BY_FIELD KEY, which
    # was spliced with a bare f-string. The key is an author-supplied field name, so a name
    # holding a quote emitted a module that does not parse -- and the module is the lookup
    # surface every consumer reads a column through.
    model = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Cust",
                        "children": [
                            {"source.rdb": {"@table": "custs"}},
                            {"field.long": {"name": "id"}},
                            {"field.string": {"name": 'zz"quoted', "@column": "zz_col"}},
                            {"identity.primary": {"@fields": ["id"], "@generation": "increment"}},
                        ],
                    }
                }
            ],
        }
    }
    loader = MetaDataLoader()
    result = loader.load([
        InMemoryStringSource(json.dumps(model), format=MetaDataFormat.JSON, id="q.json")
    ])
    assert [str(e) for e in result.errors] == []
    out = tmp_path / "gen"
    run_gen(
        GenConfig(out_dir=str(out), column_naming="snake_case"),
        result.root,
        generators=[names_generator()],
    )
    src = (out / "cust_names.py").read_text()

    # The emitted module must PARSE -- the assertion the SyntaxError would have made.
    tree = ast.parse(src)
    # ...and the key must round-trip to the authored name exactly. Read it back off the
    # AST rather than matching source text: the formatter is free to re-quote the literal
    # (ruff renders it \'zz"quoted\'), and the guarantee is the VALUE, not the spelling.
    keys: list[str] = [
        k.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Dict)
        for k in node.keys
        if isinstance(k, ast.Constant) and isinstance(k.value, str)
    ]
    assert 'zz"quoted' in keys, keys
