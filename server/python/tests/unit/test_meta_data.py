import pytest

from metaobjects.meta.meta_data import MetaData


class _Node(MetaData):
    """Concrete test node (MetaData is otherwise abstract-by-convention)."""


def test_fqn_uses_package() -> None:
    n = _Node("object", "entity", "Product")
    assert n.fqn() == "Product"
    n.package = "acme::commerce"
    assert n.fqn() == "acme::commerce::Product"


def test_own_children_and_freeze_gate() -> None:
    parent = _Node("object", "entity", "P")
    child = _Node("field", "long", "id")
    parent.add_child(child)
    assert [c.name for c in parent.own_children()] == ["id"]
    parent.freeze()
    assert parent.frozen and child.frozen
    try:
        parent.add_child(_Node("field", "string", "x"))
        raise AssertionError("expected mutation-after-freeze to raise")
    except RuntimeError:
        pass


def test_children_effective_super_chain_override() -> None:
    """children() returns effective children: super + own, own overrides by (type, name)."""
    base = _Node("object", "entity", "Base")
    base.add_child(_Node("field", "long", "id"))
    sub = _Node("object", "entity", "Sub")
    sub.add_child(_Node("field", "string", "email"))
    sub.super_data = base
    names = [c.name for c in sub.children()]
    assert names == ["id", "email"]


def test_own_children_excludes_inherited() -> None:
    """own_children() returns only direct children, not inherited."""
    base = _Node("object", "entity", "Base")
    base.add_child(_Node("field", "long", "id"))
    sub = _Node("object", "entity", "Sub")
    sub.add_child(_Node("field", "string", "email"))
    sub.super_data = base
    names = [c.name for c in sub.own_children()]
    assert names == ["email"]


# ---------------------------------------------------------------------------
# Cycle-guard tests
# ---------------------------------------------------------------------------

def test_children_mutual_cycle_does_not_raise() -> None:
    """A mutual cycle (A → B → A) must not raise RecursionError.

    Both nodes have own children.  children() on A must return A's own
    children (B's super chain is cut off at the cycle boundary) without crashing.
    """
    a = _Node("object", "entity", "A")
    a.add_child(_Node("field", "long", "a_field"))

    b = _Node("object", "entity", "B")
    b.add_child(_Node("field", "long", "b_field"))

    # Mutual cycle
    a.super_data = b
    b.super_data = a

    a.freeze()

    # Must not raise RecursionError
    result = a.children()
    names = {c.name for c in result}

    # A's own child must be present; no crash is the primary assertion
    assert "a_field" in names


def test_children_self_cycle_does_not_raise() -> None:
    """A self-cycle (A.super_data = A) must not raise RecursionError.

    The node should return its own children gracefully.
    """
    a = _Node("object", "entity", "A")
    a.add_child(_Node("field", "string", "x"))

    # Self-cycle
    a.super_data = a

    a.freeze()

    result = a.children()
    names = [c.name for c in result]
    assert names == ["x"]


def test_children_cache_still_works_after_normal_chain() -> None:
    """Ensure memoisation still operates for non-cycle super chains."""
    base = _Node("object", "entity", "Base")
    base.add_child(_Node("field", "long", "base_id"))

    sub = _Node("object", "entity", "Sub")
    sub.add_child(_Node("field", "string", "own_field"))
    sub.super_data = base

    sub.freeze()

    first = sub.children()
    second = sub.children()

    # Same list object returned from cache
    assert first is second
    assert [c.name for c in first] == ["base_id", "own_field"]


# ---------------------------------------------------------------------------
# attrs() — effective attr value map
# ---------------------------------------------------------------------------

def test_attrs_effective_includes_inherited() -> None:
    """attrs() returns effective attr map: super attrs + own attrs, own wins on conflict."""
    base = _Node("object", "entity", "Base")
    base.set_attr("color", "red")
    base.set_attr("size", "large")

    sub = _Node("object", "entity", "Sub")
    sub.set_attr("color", "blue")  # override
    sub.super_data = base

    result = sub.attrs()
    assert result["color"] == "blue"   # own wins
    assert result["size"] == "large"   # inherited


def test_own_attrs_excludes_inherited() -> None:
    """own_attrs() returns only own attrs, not inherited."""
    base = _Node("object", "entity", "Base")
    base.set_attr("color", "red")

    sub = _Node("object", "entity", "Sub")
    sub.set_attr("size", "large")
    sub.super_data = base

    result = sub.own_attrs()
    assert "size" in result
    assert "color" not in result


def test_attrs_cycle_guard_does_not_raise() -> None:
    """attrs() cycle guard: mutual cycle (A ↔ B) must not raise RecursionError."""
    a = _Node("object", "entity", "A")
    a.set_attr("x", 1)
    b = _Node("object", "entity", "B")
    b.set_attr("y", 2)
    a.super_data = b
    b.super_data = a
    # Must not raise
    result = a.attrs()
    assert result["x"] == 1
