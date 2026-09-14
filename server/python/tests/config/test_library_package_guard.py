"""FR-043 §3.4 / §3.5 — an adopter's own file in a shipped library's package.

Mirrors the TypeScript ``sdk/test/library-package-guard.test.ts``. Two failures,
opposite in shape and both silent before this guard: the ejected copy still named in
``libraries`` (additions take, deletions do not) and a new node declared into a package
the library owns. The ``overlay: true`` door stays open — ``is_merge`` is what tells an
amendment from a copy, a distinction no comparison of the merged trees could make.
"""

from __future__ import annotations

import pytest

from metaobjects import MetaDataLoader
from metaobjects.config.dependencies import refuse_library_package_misuse
from metaobjects.errors import ErrorCode, ParseError
from metaobjects.library import library_sources
from metaobjects.loader.sources.meta_data_source import (
    InMemoryStringSource,
    MetaDataFormat,
)

COPY_OF_A_SHIPPED_NODE = """
metadata:
  package: metaobjects::iam
  children:
    - object.entity:
        name: User
        children:
          - field.string: { name: nickname }
"""

OVERLAY_OF_A_SHIPPED_NODE = """
metadata:
  package: metaobjects::iam
  children:
    - object.entity:
        name: User
        overlay: true
        children:
          - field.string: { name: nickname }
"""

A_NEW_NODE_IN_THE_LIBRARYS_PACKAGE = """
metadata:
  package: metaobjects::iam
  children:
    - object.entity:
        name: ApiKey
        children:
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
"""

MY_OWN_PACKAGE = """
metadata:
  package: acme::app
  children:
    - object.entity:
        name: Account
        extends: metaobjects::iam::User
        children:
          - identity.primary: { name: pk, fields: [id] }
"""


def _load(yaml: str, libraries: list[str] | None = None):
    selection = ["iam"] if libraries is None else libraries
    sources = [*library_sources(selection), InMemoryStringSource(yaml, "mine.yaml", MetaDataFormat.YAML)]
    result = MetaDataLoader(strict=True).load(sources)
    assert not result.errors, [str(e) for e in result.errors]
    refuse_library_package_misuse(result.root, selection)
    return result.root


def test_an_ejected_copy_that_is_still_opted_in_is_refused() -> None:
    with pytest.raises(ParseError) as caught:
        _load(COPY_OF_A_SHIPPED_NODE)
    assert caught.value.code is ErrorCode.ERR_LIBRARY_PACKAGE_COLLISION
    # The message must say WHY silence would be worse: the merge is asymmetric.
    assert "DELETIONS" in str(caught.value)
    assert "metaobjects::iam::User" in str(caught.value)


def test_a_new_node_in_the_librarys_package_is_refused() -> None:
    with pytest.raises(ParseError) as caught:
        _load(A_NEW_NODE_IN_THE_LIBRARYS_PACKAGE)
    assert caught.value.code is ErrorCode.ERR_LIBRARY_PACKAGE_NOT_OWNED
    assert "metaobjects::iam::ApiKey" in str(caught.value)


def test_an_overlay_amendment_is_the_documented_door() -> None:
    assert _load(OVERLAY_OF_A_SHIPPED_NODE) is not None


def test_your_own_package_extending_a_library_node_is_untouched() -> None:
    assert _load(MY_OWN_PACKAGE) is not None


def test_with_the_library_not_opted_in_the_guard_says_nothing() -> None:
    """Which is the state ``meta eject`` leaves you in once the library is removed from
    ``libraries`` — refusing it there would make the ejection door unusable."""
    sources = [InMemoryStringSource(COPY_OF_A_SHIPPED_NODE, "mine.yaml", MetaDataFormat.YAML)]
    result = MetaDataLoader(strict=True).load(sources)
    refuse_library_package_misuse(result.root, [])


def test_the_librarys_own_layers_do_not_trip_it() -> None:
    """``iam/db`` is nothing but ``overlay: true`` redeclarations of ``iam``'s own nodes,
    from library files. A guard keyed on "two files contributed" would fire on each."""
    root = _load(MY_OWN_PACKAGE, ["iam", "iam/db"])
    assert any(c.name == "User" for c in root.own_children())
