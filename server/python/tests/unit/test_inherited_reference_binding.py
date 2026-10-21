"""A root-declared reference inherited into package ``acme`` keeps meaning the root object
even though ``acme`` declares an object of the same short name (ADR-0059 Decision 3, 7)."""
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import MetaDataLoader
from metaobjects.meta.core.identity.identity_constants import IDENTITY_REFERENCE_ATTR_REFERENCES
from metaobjects.meta.core.relationship.derive_m2m_fields import derive_m2m_fields
from metaobjects.meta.core.relationship.relationship_constants import (
    RELATIONSHIP_ATTR_OBJECT_REF,
    RELATIONSHIP_ATTR_THROUGH,
)
from metaobjects.naming_refs import ref_target

_INPUT = Path(__file__).resolve().parents[4] / "fixtures/codegen-conformance/cross-package-binding/input"


def _by_key(root, key):
    return next(c for c in root.children() if c.resolution_key() == key)


def test_inherited_references_bind_the_root_objects() -> None:
    root = MetaDataLoader.from_directory(_INPUT).root
    order = _by_key(root, "acme::Order")
    customer = next(c for c in order.children() if c.name == "customer")
    labels = next(c for c in order.children() if c.name == "labels")
    customer_ref = next(c for c in order.children() if c.name == "customerRef")

    assert ref_target(customer, RELATIONSHIP_ATTR_OBJECT_REF) is _by_key(root, "Customer")
    assert ref_target(customer_ref, IDENTITY_REFERENCE_ATTR_REFERENCES) is _by_key(root, "Customer")
    assert ref_target(labels, RELATIONSHIP_ATTR_OBJECT_REF) is _by_key(root, "Label")
    assert ref_target(labels, RELATIONSHIP_ATTR_THROUGH) is _by_key(root, "OrderLabel")
    assert _by_key(root, "acme::Customer") is not ref_target(customer, RELATIONSHIP_ATTR_OBJECT_REF)

    fields = derive_m2m_fields(labels, order)
    assert (fields.source_field, fields.target_field) == ("orderId", "labelId")
