"""``resolve_claim`` — an ``@implementedBy`` reference resolved to the node it names.

The corpora pin the gate's verdicts; this pins the resolver's own contract for a reference
that goes THREE segments deep (``Owner.member.child``), which every other resolution in the
suite reaches only through the gate's yes/no.
"""

from __future__ import annotations

from metaobjects import MetaDataLoader
from metaobjects.loader.meta_data_loader import MetaDataFormat
from metaobjects.meta.core.requirement.resolve_claim import resolve_claim

_DOC = """
metadata:
  package: acme::shop
  children:
    - object.entity:
        name: Order
        children:
          - field.uuid: { name: id }
          - field.currency:
              name: total
              currency: USD
              children:
                - view.currency: { name: display, locale: en-US }
          - identity.primary: { name: pk, fields: [id] }
"""


def _root():
    result = MetaDataLoader.from_string(_DOC, format=MetaDataFormat.YAML, strict=True)
    assert [str(e) for e in result.errors] == []
    return result.root


def test_a_three_segment_member_reference_resolves_to_the_innermost_node() -> None:
    node = resolve_claim(_root(), "Order.total.display", "acme::shop")
    assert node is not None
    assert (node.type, node.sub_type, node.name) == ("view", "currency", "display")


def test_a_three_segment_member_reference_does_not_resolve_when_a_segment_is_missing() -> None:
    root = _root()
    assert resolve_claim(root, "Order.total.nothing", "acme::shop") is None
    assert resolve_claim(root, "Order.nothing.display", "acme::shop") is None
    assert resolve_claim(root, "Missing.total.display", "acme::shop") is None
