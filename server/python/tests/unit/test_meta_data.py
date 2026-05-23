from metaobjects.meta.meta_data import MetaData


class _Node(MetaData):
    """Concrete test node (MetaData is otherwise abstract-by-convention)."""


def test_fqn_uses_package() -> None:
    n = _Node("object", "entity", "Product")
    assert n.fqn() == "Product"
    n.package = "acme::commerce"
    assert n.fqn() == "acme::commerce::Product"


def test_children_and_freeze_gate() -> None:
    parent = _Node("object", "entity", "P")
    child = _Node("field", "long", "id")
    parent.add_child(child)
    assert [c.name for c in parent.children()] == ["id"]
    parent.freeze()
    assert parent.frozen and child.frozen
    try:
        parent.add_child(_Node("field", "string", "x"))
        raise AssertionError("expected mutation-after-freeze to raise")
    except RuntimeError:
        pass


def test_effective_children_super_chain_override() -> None:
    base = _Node("object", "entity", "Base")
    base.add_child(_Node("field", "long", "id"))
    sub = _Node("object", "entity", "Sub")
    sub.add_child(_Node("field", "string", "email"))
    sub.super_data = base
    names = [c.name for c in sub.effective_children()]
    assert names == ["id", "email"]
