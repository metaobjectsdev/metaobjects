import pytest

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


# ---------------------------------------------------------------------------
# Cycle-guard tests (Fix 1)
# ---------------------------------------------------------------------------

def test_effective_children_mutual_cycle_does_not_raise() -> None:
    """A mutual cycle (A → B → A) must not raise RecursionError.

    Both nodes have own children.  effective_children() on A must return A's own
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
    result = a.effective_children()
    names = {c.name for c in result}

    # A's own child must be present; no crash is the primary assertion
    assert "a_field" in names


def test_effective_children_self_cycle_does_not_raise() -> None:
    """A self-cycle (A.super_data = A) must not raise RecursionError.

    The node should return its own children gracefully.
    """
    a = _Node("object", "entity", "A")
    a.add_child(_Node("field", "string", "x"))

    # Self-cycle
    a.super_data = a

    a.freeze()

    result = a.effective_children()
    names = [c.name for c in result]
    assert names == ["x"]


def test_effective_children_cache_still_works_after_normal_chain() -> None:
    """Ensure memoisation still operates for non-cycle super chains after the refactor."""
    base = _Node("object", "entity", "Base")
    base.add_child(_Node("field", "long", "base_id"))

    sub = _Node("object", "entity", "Sub")
    sub.add_child(_Node("field", "string", "own_field"))
    sub.super_data = base

    sub.freeze()

    first = sub.effective_children()
    second = sub.effective_children()

    # Same list object returned from cache
    assert first is second
    assert [c.name for c in first] == ["base_id", "own_field"]
