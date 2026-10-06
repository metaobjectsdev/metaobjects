"""A ``::``-relative package expands against the DECLARING file's root package.

In a multi-file collection whose files declare different root packages, the merged
root carries the first file's package. Expanding ``::parts`` later, against that
merged root, gives the wrong address; the parser expands it at parse time instead,
the same as TypeScript, C# and Java.
"""
from __future__ import annotations

from metaobjects import MetaDataLoader

_APP = """{"metadata.root": {"package": "acme::app", "children": [
  {"object.entity": {"name": "Store", "children": [
    {"field.long": {"name": "id"}},
    {"identity.primary": {"name": "pk", "@fields": ["id"]}}]}}]}}"""

_OTHER = """{"metadata.root": {"package": "beta::other", "children": [
  {"object.entity": {"name": "Gadget", "package": "::parts", "children": [
    {"field.long": {"name": "id"}},
    {"identity.primary": {"name": "pk", "@fields": ["id"]}}]}},
  {"object.entity": {"name": "Widget", "children": [
    {"field.long": {"name": "id"}},
    {"identity.primary": {"name": "pk", "@fields": ["id"]}}]}}]}}"""


def _load(tmp_path):  # type: ignore[no-untyped-def]
    (tmp_path / "meta.app.json").write_text(_APP, encoding="utf-8")
    (tmp_path / "meta.other.json").write_text(_OTHER, encoding="utf-8")
    result = MetaDataLoader.from_directory(str(tmp_path), strict=True)
    assert [str(e) for e in result.errors] == []
    return {c.name: c for c in result.root.children()}


def test_relative_package_expands_against_declaring_file_root(tmp_path) -> None:  # type: ignore[no-untyped-def]
    gadget = _load(tmp_path)["Gadget"]
    assert gadget.package == "beta::other::parts"
    assert gadget.resolution_key() == "beta::other::parts::Gadget"
    assert gadget.effective_package() == "beta::other::parts"


def test_effective_package_of_an_object_without_own_package(tmp_path) -> None:  # type: ignore[no-untyped-def]
    nodes = _load(tmp_path)
    assert nodes["Widget"].package is None
    assert nodes["Widget"].effective_package() == "beta::other"
    assert nodes["Store"].effective_package() == "acme::app"
