"""#203 / ADR-0045 — the generated FastAPI router (the deployed API surface) stamps
``@autoSet`` timestamps ABOVE the consumer repository seam, so an adopter who wires
their own persistence into the generated router still gets the shipped stamping
semantics. (The ObjectManager keeps stamping for non-HTTP writes — defense-in-depth,
not the wire-tier guarantee.) A non-``@autoSet`` entity's router stays byte-identical."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.m2m_codegen import build_object_index
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

# Event declares both @autoSet policies on field.timestamp columns; Note declares none
# (the byte-identical baseline).
_AUTOSET_FIXTURE = """{
  "metadata.root": { "package": "acme::events", "children": [
    { "object.entity": { "name": "Event", "children": [
        { "source.rdb":      { "@table": "events" } },
        { "field.long":      { "name": "id" } },
        { "field.string":    { "name": "name", "@required": true, "@maxLength": 120 } },
        { "field.timestamp": { "name": "createdAt", "@autoSet": "onCreate" } },
        { "field.timestamp": { "name": "updatedAt", "@autoSet": "onUpdate" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
    ] } },
    { "object.entity": { "name": "Note", "children": [
        { "source.rdb":      { "@table": "notes" } },
        { "field.long":      { "name": "id" } },
        { "field.string":    { "name": "title", "@required": true, "@maxLength": 200 } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
    ] } }
  ] }
}"""


def _load(fixture: str) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="router-autoset-"))
    try:
        (tmp / "meta.events.json").write_text(fixture)
        result = MetaDataLoader.from_directory(str(tmp))
        assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]
        return {
            c.name: c
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_ENTITIES = _load(_AUTOSET_FIXTURE)
_INDEX = build_object_index(list(_ENTITIES.values()))


def test_router_create_stamps_both_autoset_columns_from_one_instant() -> None:
    src = render_router(_ENTITIES["Event"], _INDEX)
    assert src is not None
    assert "import datetime as _dt" in src
    # ONE captured base instant, assigned to BOTH columns → a fresh row's createdAt == updatedAt.
    assert "_asnow = _dt.datetime.now(_dt.timezone.utc)" in src
    assert 'dto["createdAt"] = _asnow' in src
    assert 'dto["updatedAt"] = _asnow' in src


def test_router_update_bumps_only_onupdate() -> None:
    src = render_router(_ENTITIES["Event"], _INDEX)
    assert src is not None
    update_body = src.split("def update_")[1].split("def delete_")[0]
    # the update handler bumps updatedAt; createdAt is never stamped on update (immutable).
    assert 'dto["updatedAt"] = _asnow' in update_body
    assert 'dto["createdAt"] = ' not in update_body
    # #203/ADR-0045 integrity: a caller-supplied onCreate @autoSet value is STRIPPED on PATCH
    # (write-once — cannot be mutated via the deployed API), so it never reaches repo.update.
    assert 'dto.pop("createdAt", None)' in update_body


def test_non_autoset_router_is_byte_identical() -> None:
    src = render_router(_ENTITIES["Note"], _INDEX)
    assert src is not None
    assert "import datetime as _dt" not in src
    assert "_asnow" not in src
    assert "_dt.datetime.now" not in src
