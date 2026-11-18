"""The per-root top-level index behind reference resolution (``top_level_index.py``).

Two contracts:

1. LINEAR. Resolving a reference does not walk every top-level object. Asserted by counting
   work (``resolution_key`` calls, index builds), never by wall-clock, over 1x, 5x and 10x
   generated models.
2. NEVER STALE. A lookup after the root's top-level nodes changed (a node added, removed or
   reordered, a node re-keyed by a package change, a later source merged in) sees the change.
"""
from __future__ import annotations

from pathlib import Path

from metaobjects import top_level_index
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.naming_refs import resolve_object_ref
from metaobjects.shared.base_types import SUBTYPE_ROOT, TYPE_METADATA, TYPE_OBJECT

_FITNESS = (
    Path(__file__).parents[4] / "fixtures" / "persistence-conformance" / "canonical" / "meta.fitness.json"
).read_text()


def _sources(copies: int) -> list[InMemoryStringSource]:
    """*copies* renamed copies of the fitness model, one source each."""
    return [
        InMemoryStringSource(
            _FITNESS.replace('"package": "fitness"', f'"package": "fitness_x{i:02d}"', 1),
            f"fitness_x{i:02d}.json",
        )
        for i in range(copies)
    ]


def _measure(copies: int, monkeypatch) -> tuple[int, int, int]:
    """Load *copies* copies; return (top-level nodes, resolution_key calls, index rebuilds)."""
    original = MetaData.resolution_key
    calls = 0

    def counting(self: MetaData) -> str:
        nonlocal calls
        calls += 1
        return original(self)

    monkeypatch.setattr(MetaData, "resolution_key", counting)
    rebuilds_before = top_level_index.STATS["rebuilds"]
    result = MetaDataLoader().load(_sources(copies))
    assert result.errors == []
    monkeypatch.undo()
    return len(result.root.children()), calls, top_level_index.STATS["rebuilds"] - rebuilds_before


def test_resolution_key_calls_per_top_level_node_do_not_grow_with_the_model(monkeypatch) -> None:
    n1, c1, _ = _measure(1, monkeypatch)
    n5, c5, _ = _measure(5, monkeypatch)
    n10, c10, _ = _measure(10, monkeypatch)
    per = (c1 / n1, c5 / n5, c10 / n10)
    # A scan-per-reference makes this ratio grow with the model (about 10x between 1x and 10x);
    # the index keeps it flat. 1.5 leaves room for fixed per-load work.
    assert per[1] < per[0] * 1.5
    assert per[2] < per[0] * 1.5
    # And bounded in absolute terms: a handful of key builds per top-level node, not one per
    # top-level node per reference.
    assert per[2] < 40


def test_index_rebuilds_per_load_do_not_grow_with_the_model(monkeypatch) -> None:
    n1, _, r1 = _measure(1, monkeypatch)
    n10, _, r10 = _measure(10, monkeypatch)
    # Appends are absorbed incrementally, so a rebuild happens only when the root's keys change;
    # a load must not rebuild once per top-level node.
    assert r10 <= r1 + 2
    assert r10 < n10 / 4


def _root() -> MetaRoot:
    return MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")


def _entity(name: str, package: str | None = None) -> MetaObject:
    node = MetaObject(TYPE_OBJECT, "entity", name)
    if package is not None:
        node.package = package
    return node


def _resolve(root: MetaRoot, ref: str, referrer_pkg: str = ""):
    return resolve_object_ref(root, ref, referrer_pkg)


def test_a_node_added_after_a_lookup_is_found_by_the_next_lookup() -> None:
    root = _root()
    a = _entity("A")
    root.add_child(a)
    assert _resolve(root, "A") is a
    assert _resolve(root, "B") is None
    b = _entity("B")
    root.add_child(b)
    assert _resolve(root, "B") is b
    assert _resolve(root, "A") is a


def test_first_match_still_wins_when_a_later_node_has_the_same_key() -> None:
    root = _root()
    first = _entity("Dup")
    root.add_child(first)
    assert _resolve(root, "Dup") is first
    root.add_child(_entity("Dup"))
    assert _resolve(root, "Dup") is first


def test_a_removed_node_stops_resolving() -> None:
    root = _root()
    a, b = _entity("A"), _entity("B")
    root.add_child(a)
    root.add_child(b)
    assert _resolve(root, "A") is a
    root._children.remove(a)
    assert _resolve(root, "A") is None
    assert _resolve(root, "B") is b


def test_a_removal_then_an_append_keeping_the_length_is_not_missed() -> None:
    root = _root()
    a = _entity("A")
    root.add_child(a)
    assert _resolve(root, "A") is a
    root._children.remove(a)
    c = _entity("C")
    root.add_child(c)  # same length as when the index was built
    assert _resolve(root, "A") is None
    assert _resolve(root, "C") is c


def test_a_reorder_changes_which_duplicate_wins() -> None:
    root = _root()
    first, second = _entity("Dup"), _entity("Dup")
    root.add_child(first)
    root.add_child(second)
    assert _resolve(root, "Dup") is first
    root._children.reverse()
    assert _resolve(root, "Dup") is second


def test_replacing_the_child_list_wholesale_is_seen() -> None:
    root = _root()
    a, b = _entity("A"), _entity("B")
    root.add_child(a)
    assert _resolve(root, "A") is a
    root._children = [b]
    assert _resolve(root, "A") is None
    assert _resolve(root, "B") is b


def test_a_package_change_re_keys_a_top_level_node() -> None:
    root = _root()
    a = _entity("A", "p")
    root.add_child(a)
    assert _resolve(root, "p::A") is a
    a.package = "q"
    assert _resolve(root, "p::A") is None
    assert _resolve(root, "q::A") is a
    a.package = None
    a.file_default_package = "r"
    assert _resolve(root, "q::A") is None
    assert _resolve(root, "r::A") is a


def test_a_change_to_the_roots_package_re_keys_its_package_less_children() -> None:
    root = _root()
    a = _entity("A")
    root.add_child(a)
    assert _resolve(root, "A") is a
    root.package = "rootpkg"  # a package-less child with no file package falls through to it
    assert _resolve(root, "A") is None
    assert _resolve(root, "rootpkg::A") is a


def test_a_bare_reference_falls_back_from_the_referrer_package_to_the_root_level() -> None:
    root = _root()
    root_level = _entity("Thing")
    root.add_child(root_level)
    assert _resolve(root, "Thing", "pkg") is root_level
    local = _entity("Thing", "pkg")
    root.add_child(local)
    assert _resolve(root, "Thing", "pkg") is local
    local.package = "other"
    assert _resolve(root, "Thing", "pkg") is root_level


def test_a_source_merged_in_later_contributes_its_objects() -> None:
    first, second = _sources(2)
    one = MetaDataLoader().load([first])
    assert _resolve(one.root, "fitness_x01::Program") is None
    both = MetaDataLoader().load([first, second])
    assert both.errors == []
    assert _resolve(both.root, "fitness_x01::Program") is not None
    assert _resolve(both.root, "fitness_x00::Program") is not None
