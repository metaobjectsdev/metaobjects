"""Unit tests for MetaData.resolution_key() — the package-folded FQN the runtime
ObjectClassRegistry binds on (``MetaObject.new_instance``).

The merge-dependency bug: ``resolution_key()`` walked ``self.package`` then the
ANCESTOR ``.package`` chain, ignoring ``file_default_package``. An object node
leaves its own ``package`` unset (the parser does not fold the file-default
package onto an object's own ``package``), and after a multi-file MERGE the
object's parent is the single merged root — which also carries no ``package``.
So the ancestor walk found nothing and ``resolution_key()`` fell back to the
BARE NAME, binding the WRONG (package-less) key in the runtime registry.

The fix mirrors the #37 super_resolve fix + the C#/TS ``ResolutionKey``: prefer
``self.package`` → ``self.file_default_package`` → ancestor-walk (programmatic
fallback only).
"""
from __future__ import annotations

from metaobjects.meta.meta_data import MetaData


class _Node(MetaData):
    """Concrete test node (MetaData is otherwise abstract-by-convention)."""


def test_resolution_key_prefers_own_package() -> None:
    n = _Node("object", "entity", "Person")
    n.package = "com::example::om"
    assert n.resolution_key() == "com::example::om::Person"


def test_resolution_key_uses_file_default_package_when_own_unset() -> None:
    """The regression: an object with no own ``package`` must fold its
    file-default package, NOT fall through to the bare name."""
    n = _Node("object", "entity", "Person")
    # The parser captures the file's root package here; the object's own
    # ``package`` stays None.
    n.file_default_package = "com::example::om"
    assert n.resolution_key() == "com::example::om::Person"


def test_resolution_key_own_package_beats_file_default() -> None:
    n = _Node("object", "entity", "Person")
    n.package = "com::own"
    n.file_default_package = "com::file"
    assert n.resolution_key() == "com::own::Person"


def test_resolution_key_ancestor_walk_is_programmatic_fallback() -> None:
    """With neither own nor file-default package, fall back to the nearest
    ancestor's package (covers hand-built trees / plugins)."""
    root = _Node("metadata", "root", "")
    root.package = "com::ancestor"
    obj = _Node("object", "entity", "Person")
    root.add_child(obj)  # sets obj.parent = root
    assert obj.resolution_key() == "com::ancestor::Person"


def test_resolution_key_file_default_beats_ancestor_walk() -> None:
    """file_default_package takes precedence over an ancestor's package — the
    object's own file is the authoritative package source."""
    root = _Node("metadata", "root", "")
    root.package = "com::ancestor"
    obj = _Node("object", "entity", "Person")
    obj.file_default_package = "com::file"
    root.add_child(obj)
    assert obj.resolution_key() == "com::file::Person"


def test_resolution_key_bare_name_when_no_package_anywhere() -> None:
    n = _Node("object", "entity", "Person")
    assert n.resolution_key() == "Person"
