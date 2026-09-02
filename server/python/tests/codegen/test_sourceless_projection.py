"""#271 — a projection with NO ``source.*`` anywhere in its super chain is not backed
by any store, so the DB-bound codegen tier must emit nothing for it.

This is the shape #210 makes common: a prompt payload becomes a sourceless projection.
The router generator already handles it correctly — ``primary_rdb_source`` does a
RESOLVING lookup and returns ``None`` on absence, rather than dispatching on the object
subtype — but nothing pinned that. A future edit reintroducing a subtype-keyed check
would emit a FastAPI router over a table that does not exist.

The projection reuses the entity's field SHAPE via field-level ``extends``, which
carries field properties and NOT object children, so it inherits no source. A
projection cannot extend an entity at all (FR-024/ADR-0028), which is why "sourceless
projection" is a crisp reachable shape rather than an accident.
"""

import json
import shutil
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.source_resolution import primary_rdb_source
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_SOURCE

_META = {
    "metadata.root": {
        "package": "acme::blog",
        "children": [
            {
                "object.entity": {
                    "name": "Author",
                    "children": [
                        {"source.rdb": {"@table": "authors"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "name", "@required": True}},
                        {
                            "identity.primary": {
                                "@fields": "id",
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            },
            {
                "object.projection": {
                    "name": "AuthorPayload",
                    "children": [
                        {
                            "field.string": {
                                "name": "name",
                                "extends": "acme::blog::Author.name",
                            }
                        },
                        {"field.string": {"name": "summary"}},
                    ],
                }
            },
        ],
    }
}


def _load() -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="sourceless-projection-"))
    try:
        (tmp / "meta.json").write_text(json.dumps(_META))
        result = MetaDataLoader.from_directory(str(tmp))
        assert not result.errors, "; ".join(
            f"{e.code}: {e.message}" for e in result.errors
        )
        return {
            c.name: c
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_sourceless_projection_has_no_rdb_source():
    objects = _load()
    payload = objects["AuthorPayload"]

    # Resolving: nothing inherited either — field-level extends carries field
    # properties, not object children.
    assert [c for c in payload.children() if c.type == TYPE_SOURCE] == []
    assert primary_rdb_source(payload) is None


def test_sourceless_projection_emits_no_router():
    """The generator gate, not just the helper: render_router must return None so
    no FastAPI router is emitted over a table that does not exist."""
    objects = _load()
    assert render_router(objects["AuthorPayload"]) is None

    # The no-churn half — the sourced entity still emits its router.
    emitted = render_router(objects["Author"])
    assert emitted is not None
    assert "authors" in emitted


def test_sourced_entity_still_resolves_its_source():
    """The no-churn half: the fix must not make sourced entities invisible."""
    objects = _load()
    author = objects["Author"]

    src = primary_rdb_source(author)
    assert src is not None
    assert src.physical_name() == "authors"
