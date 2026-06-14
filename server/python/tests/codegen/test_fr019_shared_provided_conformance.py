"""Cross-port FR-019 conformance for Python codegen.

Loads the shared fixture (``fixtures/codegen-conformance/shared-provided-enum/input``) and asserts
the two FR-019 behaviors (ADR-0026):

* Shared materialization — a package-level abstract ``field.enum`` (``Priority``) extended by TWO
  entities is materialized ONCE as a module-level ``class Priority(str, Enum)`` in ``enums.py``;
  both models reference it (``from .enums import Priority``), neither inlines a ``Literal``.
* ``@provided`` — a package-level abstract ``field.enum`` (``Currency``, ``@provided: true``) is NOT
  materialized; consuming models import it from the configured module. A referenced ``@provided``
  enum with no configured module is a codegen-time error naming the enum.
"""
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

import json

from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.entity_model import EntityModelGenerator


_FIXTURE_DIR = (
    Path(__file__).resolve().parents[4]
    / "fixtures/codegen-conformance/shared-provided-enum/input"
)


def _emit(config: GenConfig) -> dict[str, str]:
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    entities = [o for o in root.own_children() if isinstance(o, MetaObject)]
    ctx = GenContext(
        entities=entities,
        loaded_root=root,
        matches=lambda _e: True,
        config=config,
        warn=lambda _m: None,
    )
    return {f.path: f.content for f in EntityModelGenerator().generate(ctx)}


def test_shared_enum_is_materialized_once_and_referenced_by_both_entities() -> None:
    files = _emit(GenConfig(out_dir="", provided_enum_namespace="acme_ext.enums"))
    assert "enums.py" in files, "shared enums.py must be emitted"
    enums = files["enums.py"]
    assert enums.count("class Priority(str, Enum):") == 1, "Priority must be materialized exactly once"
    for member in ("LOW", "MEDIUM", "HIGH"):
        assert f'{member} = "{member}"' in enums

    for name in ("Ticket.py", "Order.py"):
        src = files[name]
        assert "priority: Priority" in src, f"{name} must type priority as the shared enum"
        assert "from .enums import Priority" in src, f"{name} must import the materialized enum"
        assert "Literal" not in src, f"{name} must not inline the shared enum as a Literal"


def test_provided_enum_is_not_materialized_and_imported_from_the_configured_module() -> None:
    files = _emit(GenConfig(out_dir="", provided_enum_namespace="acme_ext.enums"))
    assert "class Currency" not in files.get("enums.py", ""), "provided Currency must NOT be materialized"
    ticket = files["Ticket.py"]
    assert "from acme_ext.enums import Currency" in ticket, "currency must import from the configured module"
    assert "currency: Currency" in ticket


def test_provided_enum_with_no_module_config_is_a_codegen_error_naming_the_enum() -> None:
    with pytest.raises(ValueError) as excinfo:
        _emit(GenConfig(out_dir=""))  # no provided module configured
    assert "Currency" in str(excinfo.value)


def _emit_doc(doc: dict) -> dict[str, str]:
    root = MetaDataLoader().load(
        [InMemoryStringSource(json.dumps(doc), id="m.json", format=MetaDataFormat.JSON)]
    ).root
    entities = [o for o in root.own_children() if isinstance(o, MetaObject)]
    ctx = GenContext(
        entities=entities, loaded_root=root, matches=lambda _e: True,
        config=GenConfig(out_dir=""), warn=lambda _m: None,
    )
    return {f.path: f.content for f in EntityModelGenerator().generate(ctx)}


def test_shared_enum_members_are_uppercase_with_wire_value_preserved() -> None:
    """Python enum members follow the UPPER_CASE constant convention; the value keeps
    the wire form, so ``Enum("statistical")`` and ``member == "statistical"`` still work."""
    enums = _emit_doc({"metadata.root": {"package": "a::b", "children": [
        {"field.enum": {"name": "NumericalType", "abstract": True,
                        "@values": ["none", "statistical", "search_web"]}},
        {"object.value": {"name": "M", "children": [
            {"field.enum": {"name": "nt", "extends": "a::b::NumericalType"}}]}},
    ]}})["enums.py"]
    assert 'STATISTICAL = "statistical"' in enums
    assert 'SEARCH_WEB = "search_web"' in enums
    assert 'statistical = "statistical"' not in enums  # member is not the lowercase value
