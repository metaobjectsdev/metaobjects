"""ADR-0039 regression: a M:N relationship INHERITED via ``extends`` must resolve.

``resolve_n2m_descriptor`` previously iterated ``source_entity.own_children()``,
which silently dropped a relationship declared on an abstract base and inherited
by a concrete entity. The TS reference resolver (``n2m-resolver.ts:63``) iterates
``sourceEntity.children()`` (effective — own + inherited). This test declares the
``tags`` M:N relationship on an abstract ``PostBase`` and has a concrete ``Post``
``extends`` it; the resolver must find the inherited relationship. It fails at
``own_children()`` (returns None → treated as not-M:N) and passes at ``children()``.
"""
from __future__ import annotations

import json

from metaobjects import load_string
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.runtime.n2m_resolver import resolve_n2m_descriptor

# Abstract PostBase declares the M:N `tags` relationship (+ id/identity for shape);
# concrete Post extends it and re-declares its own source/table. The junction
# PostTag and target Tag are ordinary top-level entities. Mirrors the shape of the
# persistence-conformance Post/Tag/PostTag fixture, with the relationship hoisted
# onto an abstract base.
_META = {
    "metadata.root": {
        "package": "test::n2m",
        "children": [
            {
                "object.entity": {
                    "name": "PostBase",
                    "abstract": True,
                    "children": [
                        {"field.long": {"name": "id"}},
                        {
                            "relationship.association": {
                                "name": "tags",
                                "@cardinality": "many",
                                "@objectRef": "Tag",
                                "@through": "PostTag",
                            }
                        },
                        {
                            "identity.primary": {
                                "name": "id",
                                "@fields": "id",
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Post",
                    "extends": "PostBase",
                    "children": [
                        {"source.rdb": {"@table": "posts"}},
                        {
                            "field.string": {
                                "name": "title",
                                "@required": True,
                                "@maxLength": 200,
                            }
                        },
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Tag",
                    "children": [
                        {"source.rdb": {"@table": "tags"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "name", "@required": True, "@maxLength": 80}},
                        {
                            "identity.primary": {
                                "name": "id",
                                "@fields": "id",
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "PostTag",
                    "children": [
                        {"source.rdb": {"@table": "post_tags"}},
                        {"field.long": {"name": "postId", "@required": True}},
                        {"field.long": {"name": "tagId", "@required": True}},
                        {"identity.primary": {"name": "id", "@fields": ["postId", "tagId"]}},
                        {
                            "identity.reference": {
                                "name": "fkPost",
                                "@fields": "postId",
                                "@references": "Post",
                            }
                        },
                        {
                            "identity.reference": {
                                "name": "fkTag",
                                "@fields": "tagId",
                                "@references": "Tag",
                            }
                        },
                    ],
                }
            },
        ],
    }
}


def _load_index() -> tuple[MetaObject, dict[str, MetaObject]]:
    root = load_string(json.dumps(_META)).root
    index: dict[str, MetaObject] = {
        c.name: c for c in root.children() if isinstance(c, MetaObject)
    }
    return index["Post"], index


def test_inherited_m2n_relationship_resolves() -> None:
    """The concrete Post inherits `tags` from abstract PostBase; the resolver must
    find it (own_children() would drop the inherited relationship → None)."""
    post, index = _load_index()

    # Guard: `tags` is genuinely NOT an own child of Post — it is inherited.
    assert "tags" not in {c.name for c in post.own_children()}
    assert "tags" in {c.name for c in post.children()}

    desc = resolve_n2m_descriptor(post, "tags", index)

    assert desc is not None, (
        "inherited M:N relationship dropped — resolver read own_children() instead "
        "of the effective children()"
    )
    assert desc.source_entity_name == "Post"
    assert desc.target_entity_name == "Tag"
    assert desc.junction_entity_name == "PostTag"
    # FK direction derived from PostTag's identity.reference children (SSOT).
    assert desc.source_field == "postId"
    assert desc.target_field == "tagId"
    assert desc.symmetric is False
