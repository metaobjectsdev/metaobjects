"""Runtime-binding regression: ObjectClassRegistry / new_instance() must bind on
the CORRECT package key after a multi-file, multi-package MERGE.

Staff-review finding (W2b): the #37 serializer/super-resolve fix landed, but the
runtime resolution-key path did NOT. ``MetaData.resolution_key()`` walked the
ancestor ``.package`` chain and ignored ``file_default_package``; after a
multi-file merge an object node (own ``package`` unset, parent = the single
merged root which also has no ``package``) folded to the BARE NAME — so a factory
registered under the object's true package key was never found, and a factory
mistakenly registered under the bare name resolved the WRONG object.

This loads two in-memory files in two distinct packages, merges them, then
registers a factory under each object's package-folded ``resolution_key()`` and
asserts ``new_instance()`` resolves the right one. Before the fix the two objects
both folded to a bare name and the registry binding was wrong.
"""
from __future__ import annotations

import metaobjects.core_types  # noqa: F401 — registers attr/node classes

from metaobjects import MetaDataLoader
from metaobjects.loader.sources.meta_data_source import InMemoryStringSource
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_class_registry import ObjectClassRegistry


_FILE_A = """
{ "metadata.root": {
    "package": "com::example::alpha",
    "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]
}}
"""

_FILE_B = """
{ "metadata.root": {
    "package": "com::example::beta",
    "children": [
      { "object.entity": { "name": "Gadget", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]
}}
"""


class _AlphaBacking:
    def __init__(self, meta: MetaObject) -> None:
        self.meta = meta
        self.kind = "alpha"


class _BetaBacking:
    def __init__(self, meta: MetaObject) -> None:
        self.meta = meta
        self.kind = "beta"


def _load_merged() -> object:
    loader = MetaDataLoader()
    result = loader.load([
        InMemoryStringSource(_FILE_A, id="<test:alpha>"),
        InMemoryStringSource(_FILE_B, id="<test:beta>"),
    ])
    assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]
    return result.root


def _objects(root: object) -> list[MetaObject]:
    return [c for c in root.children() if isinstance(c, MetaObject)]  # type: ignore[attr-defined]


def test_merged_objects_carry_package_folded_resolution_keys() -> None:
    """After merging two files in distinct packages, each object's
    resolution_key() folds its OWN file-default package — NOT the bare name (the
    merge-dependency bug: the parent chain no longer reaches the per-file root)."""
    root = _load_merged()
    objs = _objects(root)
    assert len(objs) == 2
    keys = sorted(o.resolution_key() for o in objs)
    assert keys == [
        "com::example::alpha::Widget",
        "com::example::beta::Gadget",
    ], keys


def test_new_instance_binds_correct_package_after_merge() -> None:
    """new_instance() resolves each object to the factory registered under its
    OWN package-folded key — the cross-package binding is no longer
    merge-dependent. Before the fix both objects folded to bare names
    (``Widget`` / ``Gadget``) so a factory registered on the true FQN key was
    never found."""
    root = _load_merged()
    objs = {o.resolution_key(): o for o in _objects(root)}

    registry = ObjectClassRegistry()
    registry.register("com::example::alpha::Widget", _AlphaBacking)
    registry.register("com::example::beta::Gadget", _BetaBacking)

    alpha = objs["com::example::alpha::Widget"].new_instance(registry)
    beta = objs["com::example::beta::Gadget"].new_instance(registry)

    assert isinstance(alpha, _AlphaBacking) and alpha.kind == "alpha"
    assert isinstance(beta, _BetaBacking) and beta.kind == "beta"
    # back-ref attached to the right MetaObject.
    assert alpha.meta is objs["com::example::alpha::Widget"]
    assert beta.meta is objs["com::example::beta::Gadget"]
