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
import json
import sys
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
    # It declares no source. A NAME here would be a physical name invented for an object
    # that declares none — the phantom-table failure #248 exists to prevent.
    assert "BASEENTITY_NAME" not in src
    assert "BASEENTITY_KIND" not in src
    assert "BASEENTITY_READ_ONLY" not in src


def test_the_child_imports_the_base_constant_instead_of_restating_it(tmp_path: Path) -> None:
    src = _generate(tmp_path)["author_names.py"]
    assert "from .base_entity_names import" in src
    assert "AUTHOR_CREATED_AT_COLUMN: Final[str] = BASEENTITY_CREATED_AT_COLUMN" in src
    assert 'AUTHOR_EMAIL_COLUMN: Final[str] = "zz_email_addr"' in src
    # Its own source, so its own physical name.
    assert 'AUTHOR_NAME: Final[str] = "zz_authors"' in src
    # ...and NOT the inherited column, restated.
    assert "zz_made_at" not in src


def test_a_tph_subtype_references_the_shared_table_name_rather_than_restating_it(tmp_path: Path) -> None:
    src = _generate(tmp_path)["copay_auth_names.py"]
    assert "COPAYAUTH_NAME: Final[str] = AUTH_NAME" in src
    assert "COPAYAUTH_ID_COLUMN: Final[str] = AUTH_ID_COLUMN" in src
    assert 'COPAYAUTH_COPAY_AMOUNT_COLUMN: Final[str] = "zz_copay_cents"' in src
    # The whole point: the subtype used to restate the base's table name and every column.
    assert "zz_auths" not in src


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
        assert mod.COPAYAUTH_NAME == "zz_auths"
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
