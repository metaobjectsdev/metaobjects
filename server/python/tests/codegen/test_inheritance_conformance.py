"""Cross-port inheritance conformance for Python codegen.

Loads the shared fixture (``fixtures/codegen-conformance/inheritance/input``) and asserts
multi-level abstract inheritance: Python concretes SUBCLASS the immediate parent (rather
than flattening), so the inherited field set is carried across the chain
``Product(Auditable)`` → ``Auditable(Base)`` → ``Base(BaseModel)``.
"""
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.generators.entity_model import render_entity_model


_FIXTURE_DIR = Path(__file__).resolve().parents[4] / "fixtures/codegen-conformance/inheritance/input"


def _by_name() -> dict[str, MetaObject]:
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    return {
        o.name.split("::")[-1]: o
        for o in root.own_children()
        if isinstance(o, MetaObject)
    }


def test_multi_level_chain_subclasses_each_level_with_own_fields() -> None:
    objs = _by_name()

    base = render_entity_model(objs["Base"])
    assert "class Base(BaseModel):" in base
    assert "id" in base and "createdBy" in base

    auditable = render_entity_model(objs["Auditable"])
    assert "from .Base import Base" in auditable
    assert "class Auditable(Base):" in auditable
    assert "updatedBy" in auditable

    product = render_entity_model(objs["Product"])
    assert "from .Auditable import Auditable" in product
    assert "class Product(Auditable):" in product
    assert "sku" in product
    assert "qtyOnHand" in product


def test_concrete_only_declares_its_own_fields_not_inherited_ones() -> None:
    # Python inherits (does not flatten): Product must NOT redeclare the chain's fields.
    product = render_entity_model(_by_name()["Product"])
    for inherited in ("id:", "createdBy:", "updatedBy:"):
        assert inherited not in product, f"Product must inherit, not redeclare, {inherited!r}"
