"""FR-018 Unit 14 — Python M:N codegen unit tests.

Covers the build-time M:N descriptor resolution (``m2m_codegen``), the Pydantic
nested-collection emission (``entity_model``), and the FastAPI traversal route
emission (``router_generator``) for all three resolution modes: hetero, directed
self-join (``@sourceRefField``), and symmetric self-join (``@symmetric``).

The M:N corpus model (Post/Tag/PostTag + Person/Follow/Friendship) is loaded
from the shared api-contract fixture so the unit tests exercise the SAME metadata
the cross-port api-contract conformance does.
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import metaobjects.core_types  # noqa: F401 — registers attr/relationship classes
from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.m2m_codegen import (
    build_object_index,
    resolve_m2m_descriptors,
)
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _find_corpus_meta() -> Path:
    cur = Path(__file__).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "m2m" / "meta.json"
        if candidate.is_file():
            return candidate
        cur = cur.parent
    raise RuntimeError("Could not locate fixtures/api-contract-conformance/m2m/meta.json")


def _load_entities() -> dict[str, MetaObject]:
    meta = _find_corpus_meta()
    tmp = Path(tempfile.mkdtemp(prefix="m2m-meta-"))
    try:
        shutil.copy(meta, tmp / "meta.json")
        result = MetaDataLoader.from_directory(str(tmp))
        assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]
        return {
            c.name: c
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_ENTITIES = _load_entities()
_INDEX = build_object_index(list(_ENTITIES.values()))


# ---------------------------------------------------------------------------
# Descriptor resolution — the three modes
# ---------------------------------------------------------------------------


def test_hetero_descriptor() -> None:
    descs = resolve_m2m_descriptors(_ENTITIES["Post"], _INDEX)
    assert len(descs) == 1
    d = descs[0]
    assert d.relation_name == "tags"
    assert d.target_entity == "Tag"
    assert d.source_plural == "posts"
    assert d.target_plural == "tags"
    assert d.junction_table == "post_tags"
    assert d.target_table == "tags"
    assert d.source_column == "postId"
    assert d.target_column == "tagId"
    assert d.target_pk_column == "id"
    assert d.symmetric is False


def test_directed_and_symmetric_descriptors() -> None:
    descs = {d.relation_name: d for d in resolve_m2m_descriptors(_ENTITIES["Person"], _INDEX)}
    assert set(descs) == {"following", "friends"}

    following = descs["following"]
    assert following.source_plural == "persons"  # entity name pluralized, NOT @table "people"
    assert following.junction_table == "follows"
    assert following.source_column == "followerId"  # @sourceRefField
    assert following.target_column == "followeeId"
    assert following.symmetric is False

    friends = descs["friends"]
    assert friends.junction_table == "friendships"
    assert friends.source_column == "personAId"  # declaration order
    assert friends.target_column == "personBId"
    assert friends.symmetric is True


def test_entity_without_m2m_has_no_descriptors() -> None:
    assert resolve_m2m_descriptors(_ENTITIES["Tag"], _INDEX) == []


# ---------------------------------------------------------------------------
# Pydantic nested collection (entity_model)
# ---------------------------------------------------------------------------


def test_pydantic_nested_collection_emitted() -> None:
    src = render_entity_model(_ENTITIES["Post"], _INDEX)
    assert "tags: list[Tag] = []" in src
    assert "from .Tag import Tag" in src


def test_pydantic_self_referential_collection() -> None:
    src = render_entity_model(_ENTITIES["Person"], _INDEX)
    # Self-join: the element type is the entity itself (forward ref string).
    assert 'following: list["Person"] = []' in src
    assert 'friends: list["Person"] = []' in src


# ---------------------------------------------------------------------------
# FastAPI traversal route (router_generator)
# ---------------------------------------------------------------------------


def test_router_emits_m2m_route_hetero() -> None:
    out = render_router(_ENTITIES["Post"], _INDEX)
    assert out is not None
    # GET /posts/{id}/tags traversal route mounted on the /api/posts router.
    assert '@router.get("/{post_id}/tags")' in out
    assert "def list_post_tags(" in out
    assert "find_related_tags" in out


def test_router_emits_m2m_routes_self_join() -> None:
    out = render_router(_ENTITIES["Person"], _INDEX)
    assert out is not None
    assert '@router.get("/{person_id}/following")' in out
    assert '@router.get("/{person_id}/friends")' in out
    assert "find_related_following" in out
    assert "find_related_friends" in out


def test_router_repository_protocol_declares_related_finders() -> None:
    out = render_router(_ENTITIES["Person"], _INDEX)
    assert out is not None
    # The consumer seam grows a typed finder per M:N navigation.
    assert "def find_related_following(self, id: int) -> list[Any]: ..." in out
    assert "def find_related_friends(self, id: int) -> list[Any]: ..." in out


def test_router_without_object_index_is_crud_only() -> None:
    # Back-compat: render_router(entity) with no index emits CRUD only (no M:N).
    out = render_router(_ENTITIES["Post"])
    assert out is not None
    assert "/tags" not in out
    assert "find_related" not in out
