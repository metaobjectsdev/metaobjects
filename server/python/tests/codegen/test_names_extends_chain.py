""""Those names modules should extend from the parent, not just redo all the names."

A TPH subtype's module restated its base's table name and every one of its columns; an
entity extending an abstract base restated every inherited column. Each restatement is a
second place one physical name is spelled — the exact defect the names artifact exists to
remove, reintroduced one level up.

Python has no static inheritance to lean on, so the inherited constants are re-exported BY
REFERENCE to the base module's own. One spelling of each physical name, which is the whole
guarantee; the emitted shape differs per language (C# and Java use real class
inheritance), the guarantee does not.

Every assertion is stated in the NEGATIVE as well as the positive: an inherited physical
name must be ABSENT from the child's module. A positive-only assertion would pass just as
well for a generator emitting both the reference AND the restated literal, which is the
outcome this change exists to prevent.
"""
from __future__ import annotations

import importlib.util
import ast
import json
import sys

import pytest
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.names_generator import names_generator
from metaobjects.codegen.runner import run_gen

MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {
                "object.entity": {
                    "name": "BaseEntity",
                    "abstract": True,
                    "children": [
                        {"field.long": {"name": "id"}},
                        # NOT the snake_case of its field name: a restated literal cannot
                        # be mistaken for a re-derivation.
                        {"field.timestamp": {"name": "createdAt", "@column": "zz_made_at"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Author",
                    "extends": "BaseEntity",
                    "children": [
                        {"source.rdb": {"@table": "zz_authors"}},
                        {"field.string": {"name": "email", "@column": "zz_email_addr", "@required": True}},
                        {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Auth",
                    "@discriminator": "kind",
                    "children": [
                        {"source.rdb": {"@table": "zz_auths"}},
                        {"field.long": {"name": "id"}},
                        {"field.enum": {"name": "kind", "@values": ["Copay"]}},
                        {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "CopayAuth",
                    "extends": "Auth",
                    "@discriminatorValue": "Copay",
                    "children": [
                        {"field.long": {"name": "copayAmount", "@column": "zz_copay_cents"}}
                    ],
                }
            },
            {
                "object.value": {
                    "name": "Money",
                    "children": [{"field.long": {"name": "cents", "@column": "zz_cents"}}],
                }
            },
        ],
    }
}


def _generate(tmp_path: Path) -> dict[str, str]:
    loader = MetaDataLoader()
    result = loader.load([
        InMemoryStringSource(json.dumps(MODEL), format=MetaDataFormat.JSON, id="extends.json"),
    ])
    assert [str(e) for e in result.errors] == []
    out = tmp_path / "gen"
    run_gen(
        GenConfig(out_dir=str(out), column_naming="snake_case"),
        result.root,
        generators=[names_generator()],
    )
    return {str(p.relative_to(out)): p.read_text() for p in out.rglob("*.py")}


def test_the_abstract_base_gets_a_module_carrying_columns_and_no_physical_name(tmp_path: Path) -> None:
    src = _generate(tmp_path)["base_entity_names.py"]
    assert 'BASEENTITY_CREATED_AT_COLUMN: Final[str] = "zz_made_at"' in src
    assert 'BASEENTITY_ID_COLUMN: Final[str] = "id"' in src
    # A fragment keeps its OWN identity — type, subType and name — because those are
    # facts about the object, not about a table it does not have.
    assert 'BASEENTITY_TYPE: Final[str] = "object"' in src
    assert 'BASEENTITY_SUB_TYPE: Final[str] = "entity"' in src
    assert 'BASEENTITY_NAME: Final[str] = "BaseEntity"' in src
    # It declares no source. A physical name here would be one invented for an object
    # that declares none — the phantom-table failure #248 exists to prevent.
    assert "BASEENTITY_SOURCE_" not in src
    assert "READ_ONLY" not in src


def test_the_child_imports_the_base_constant_instead_of_restating_it(tmp_path: Path) -> None:
    src = _generate(tmp_path)["author_names.py"]
    assert "from .base_entity_names import" in src
    assert "AUTHOR_CREATED_AT_COLUMN: Final[str] = BASEENTITY_CREATED_AT_COLUMN" in src
    assert 'AUTHOR_EMAIL_COLUMN: Final[str] = "zz_email_addr"' in src
    # Its own source, so its own physical name — under the member for its @kind.
    assert 'AUTHOR_SOURCE_PRIMARY_TABLE: Final[str] = "zz_authors"' in src
    # ...and its own name, which is the OBJECT's, not the table's.
    assert 'AUTHOR_NAME: Final[str] = "Author"' in src
    # ...and NOT the inherited column, restated.
    assert "zz_made_at" not in src


def test_a_tph_subtype_references_the_shared_table_name_rather_than_restating_it(tmp_path: Path) -> None:
    src = _generate(tmp_path)["copay_auth_names.py"]
    assert "COPAYAUTH_SOURCE_PRIMARY_TABLE: Final[str] = AUTH_SOURCE_PRIMARY_TABLE" in src
    assert "COPAYAUTH_ID_COLUMN: Final[str] = AUTH_ID_COLUMN" in src
    assert 'COPAYAUTH_COPAY_AMOUNT_COLUMN: Final[str] = "zz_copay_cents"' in src
    # A single-table hierarchy legitimately has two OBJECT names; only the physical one
    # is shared. So the subtype keeps its own name/type/subType as literals.
    assert 'COPAYAUTH_NAME: Final[str] = "CopayAuth"' in src
    # An inherited identity is reached through the base's constant, not restated.
    assert "COPAYAUTH_IDENTITY_PK_NAME: Final[str] = AUTH_IDENTITY_PK_NAME" in src
    # The whole point: the subtype used to restate the base's table name and every column.
    assert "zz_auths" not in src


KEY_ONLY_MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {
                "object.entity": {
                    "name": "Base",
                    "abstract": True,
                    "children": [
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "email", "@column": "zz_email_addr"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Audited",
                    "abstract": True,
                    "extends": "Base",
                    "children": [
                        {"identity.secondary": {"name": "by_email", "@fields": ["email"]}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Widget",
                    "extends": "Audited",
                    "children": [
                        {"source.rdb": {"@table": "zz_widgets"}},
                        {"identity.primary": {"@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            },
        ],
    }
}


def _generate_model(tmp_path: Path, model: dict) -> dict[str, str]:
    loader = MetaDataLoader()
    result = loader.load([
        InMemoryStringSource(json.dumps(model), format=MetaDataFormat.JSON, id="m.json"),
    ])
    assert [str(e) for e in result.errors] == []
    out = tmp_path / "gen"
    run_gen(
        GenConfig(out_dir=str(out), column_naming="snake_case"),
        result.root,
        generators=[names_generator()],
    )
    return {str(p.relative_to(out)): p.read_text() for p in out.rglob("*.py")}


def test_a_key_only_abstract_is_a_link_in_the_chain_not_a_node_to_walk_past(
    tmp_path: Path,
) -> None:
    # `Audited` declares NO field and NO source -- only a key. That is the whole reason
    # such a node exists: hoist one `identity.secondary` onto a chain. The "has anything
    # to contribute" test used to ask about fields and sources alone, so this node
    # answered "no", the walk stepped over it, and no module was rendered for it. Python
    # does not break on that the way the other ports do -- it re-states the key's literal
    # on the child instead -- which is why nothing caught it and why the assertion below
    # is stated in the NEGATIVE as well: the physical name is supposed to be spelled ONCE.
    files = _generate_model(tmp_path, KEY_ONLY_MODEL)

    assert "audited_names.py" in files, sorted(files)
    assert 'AUDITED_IDENTITY_BY_EMAIL_NAME: Final[str] = "by_email"' in files["audited_names.py"]

    widget = files["widget_names.py"]
    assert "from .audited_names import" in widget
    assert "WIDGET_IDENTITY_BY_EMAIL_NAME: Final[str] = AUDITED_IDENTITY_BY_EMAIL_NAME" in widget
    assert 'WIDGET_IDENTITY_BY_EMAIL_NAME: Final[str] = "by_email"' not in widget


def test_a_sourceless_object_nothing_persistable_extends_still_gets_nothing(tmp_path: Path) -> None:
    # #248 intact. The fragment is reached by walking `extends` UPWARD from a database
    # participant — the only context in which an object's fields are columns at all. An
    # object.value carrying fields is not reached, so it acquires no module and no phantom
    # participation. Without this the "abstract base" relaxation would have quietly become
    # "anything with fields".
    assert "money_names.py" not in _generate(tmp_path)


def test_the_emitted_modules_import_and_an_inherited_constant_resolves(tmp_path: Path) -> None:
    """The teeth. Every assertion above is about TEXT; only actually importing the modules
    proves the re-exported reference resolves — that the import line names a module that
    exists, exporting a symbol that exists, under the name the child expects."""
    tree = _generate(tmp_path)
    pkg = tmp_path / "gen"
    (pkg / "__init__.py").write_text("")
    sys.path.insert(0, str(tmp_path))
    try:
        spec = importlib.util.spec_from_file_location("gen.copay_auth_names", pkg / "copay_auth_names.py")
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        sys.modules["gen.copay_auth_names"] = mod
        spec.loader.exec_module(mod)

        # An inherited constant, reached through the reference the generator emitted.
        assert mod.COPAYAUTH_SOURCE_PRIMARY_TABLE == "zz_auths"
        assert mod.COPAYAUTH_SOURCE_PRIMARY_KIND == "table"
        assert mod.COPAYAUTH_IDENTITY_PK_SUB_TYPE == "primary"
        assert mod.COPAYAUTH_NAME == "CopayAuth"
        assert mod.COPAYAUTH_ID_COLUMN == "id"
        assert mod.COPAYAUTH_COPAY_AMOUNT_COLUMN == "zz_copay_cents"
        # COLUMNS_BY_FIELD stays COMPLETE — it is the lookup surface, and a miss on an
        # inherited field is the fallback-to-literal this artifact removes.
        assert mod.COPAYAUTH_COLUMNS_BY_FIELD == {
            "copayAmount": "zz_copay_cents", "id": "id", "kind": "kind",
        }
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("gen.copay_auth_names", None)
        assert tree  # keep the generated tree referenced for a readable failure


def test_a_child_field_colliding_with_an_inherited_one_is_refused_naming_the_model(tmp_path: Path) -> None:
    """The guard has to see the WHOLE field set, not just what this module declares.

    Once a child stopped restating its inherited constants, an own-only check could no
    longer see a collision that spans the ``extends`` boundary — and here both constants
    land in the SAME module (the child re-exports the inherited one under its own name), so
    the later assignment would silently win and ``COLUMNS_BY_FIELD`` would map the inherited
    field name to the child's column.
    """
    import pytest

    from metaobjects.codegen.generators.names_generator import render_names

    model = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "BaseRow",
                        "abstract": True,
                        "children": [{"field.timestamp": {"name": "createdAt"}}],
                    }
                },
                {
                    "object.entity": {
                        "name": "Row",
                        "extends": "BaseRow",
                        "children": [
                            {"source.rdb": {"@table": "rows"}},
                            {"field.long": {"name": "id"}},
                            {"field.timestamp": {"name": "created_at"}},
                            {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                        ],
                    }
                },
            ],
        }
    }
    result = MetaDataLoader().load([
        InMemoryStringSource(json.dumps(model), format=MetaDataFormat.JSON, id="collide.json"),
    ])
    assert [str(e) for e in result.errors] == []
    row = next(o for o in result.root.own_children() if o.name == "Row")

    with pytest.raises(ValueError) as exc:
        render_names(row, "snake_case")
    message = str(exc.value)
    assert "createdAt" in message
    assert "created_at" in message
    assert "CREATED_AT" in message


def _render(model: dict, entity_name: str, strategy: str = "snake_case") -> str | None:
    from metaobjects.codegen.generators.names_generator import render_names

    result = MetaDataLoader().load([
        InMemoryStringSource(json.dumps(model), format=MetaDataFormat.JSON, id="roles.json"),
    ])
    assert [str(e) for e in result.errors] == []
    entity = next(o for o in result.root.own_children() if o.name == entity_name)
    return render_names(entity, strategy)


def _role_model(child_source: dict) -> dict:
    """An abstract base and its child EACH declaring a ``@role: primary`` source.

    Both sources carry an explicit structural ``name``, and that is load-bearing:
    effective-children shadowing matches an own child over a super child on a
    ``(type, name)`` pair, so two UNNAMED sources across an ``extends`` boundary
    collapse into one and never reach the role map at all. Named, both land on the
    child's effective ``children()`` — which is the shape ``primary_rdb_source``'s
    own divergence guard documents, and the only one that can put two sources in one
    role key.
    """
    return {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "RoleBase",
                        "abstract": True,
                        "children": [
                            {"source.rdb": {"name": "base_src", "@table": "zz_shared"}},
                            {"field.long": {"name": "id"}},
                        ],
                    }
                },
                {
                    "object.entity": {
                        "name": "RoleChild",
                        "extends": "RoleBase",
                        "children": [child_source, {"field.string": {"name": "nm"}}],
                    }
                },
            ],
        }
    }


def test_two_sources_in_one_role_that_AGREE_are_legal() -> None:
    """The refusal is about DISAGREEMENT, not about the count — deliberately the same
    rule ``primary_rdb_source`` already enforces, rather than a stricter one invented
    for this artifact.

    An abstract base and the child that extends it may each declare a ``@role:
    primary`` source naming the same relation. That loads with zero errors today, so a
    guard keyed on "more than one source in this role" would make the names module
    stricter than the invariant it exists to serve — and would fail a model the product
    itself sanctions.
    """
    src = _render(
        _role_model({"source.rdb": {"name": "child_src", "@table": "zz_shared"}}),
        "RoleChild",
    )
    assert src is not None
    # One constant for the role, whichever of the two declarations it came from — the
    # point is that agreeing declarations produce ONE spelling, not a refusal and not
    # two constants racing to define the same member.
    assert "ROLECHILD_SOURCE_PRIMARY_TABLE: Final[str] = " in src
    assert src.count("ROLECHILD_SOURCE_PRIMARY_TABLE: Final") == 1


def test_two_sources_in_one_role_that_DISAGREE_are_refused_naming_both() -> None:
    """...and the disagreement is the real problem, because keeping one silently is the
    failure this artifact makes impossible: the second name would be carried nowhere,
    read by nobody, while the binding quietly took the first's.

    A ``@schema`` disagreement is the arm this module owns, and it is what makes the
    check non-redundant: ``primary_rdb_source`` compares physical NAMES only, so two
    primaries agreeing on the name and differing on which SCHEMA it lives in get past
    it and land on one role key here. (A ``@kind`` disagreement in the primary role is
    unreachable — the loader refuses a read-only primary outright,
    ``ERR_ENTITY_PRIMARY_SOURCE_READONLY``; a physical-NAME disagreement is refused one
    level down, by ``primary_rdb_source``.)
    """
    model = _role_model(
        {"source.rdb": {"name": "child_src", "@table": "zz_shared", "@schema": "zz_other"}}
    )
    with pytest.raises(ValueError) as exc:
        _render(model, "RoleChild")
    message = str(exc.value)
    assert '@role: "primary"' in message
    assert "zz_shared" in message


TPH_MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {
                "object.entity": {
                    "name": "Auth",
                    "@discriminator": "kind",
                    "children": [
                        {"source.rdb": {"@table": "zz_auths"}},
                        {"field.long": {"name": "id"}},
                        {"field.enum": {"name": "kind", "@values": ["Copay"]}},
                        {"identity.primary": {"@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "CopayAuth",
                    "extends": "Auth",
                    "@discriminatorValue": "Copay",
                    "children": [
                        {"field.long": {"name": "copayAmount", "@column": "zz_copay_cents"}},
                    ],
                }
            },
        ],
    }
}


def test_a_scoped_run_still_names_the_shared_table(tmp_path: Path) -> None:
    # `metaobjects gen --entities CopayAuth`. Pass 1 emits the subtype; pass 2 walks up to
    # `Auth` and used to render it as a FRAGMENT unconditionally. A fragment declares no
    # source, by design, because it has no physical name -- but `Auth` DOES have one: it is
    # the TPH base, and the shared table is named on it. So the base module came out with no
    # SOURCE_* constants at all while the subtype's module still imported them by name: an
    # ImportError on a module the tool had just written.
    loader = MetaDataLoader()
    result = loader.load([
        InMemoryStringSource(json.dumps(TPH_MODEL), format=MetaDataFormat.JSON, id="tph.json"),
    ])
    assert [str(e) for e in result.errors] == []
    out = tmp_path / "gen"
    run_gen(
        GenConfig(out_dir=str(out), column_naming="snake_case"),
        result.root,
        generators=[names_generator()],
        entity_filter=["CopayAuth"],
    )
    files = {str(p.relative_to(out)): p.read_text() for p in out.rglob("*.py")}

    base = files["auth_names.py"]
    assert 'AUTH_SOURCE_PRIMARY_TABLE: Final[str] = "zz_auths"' in base, base

    # Every name the subtype imports from the base must EXIST in it -- the assertion the
    # ImportError would have made at runtime, made here instead.
    child = files["copay_auth_names.py"]
    imported = [
        alias.name
        for node in ast.walk(ast.parse(child))
        if isinstance(node, ast.ImportFrom) and node.module == "auth_names"
        for alias in node.names
    ]
    assert imported, child
    for name in imported:
        assert f"{name}: Final" in base, f"{name} imported from auth_names but not defined there"
