"""Follow-up to #368 — M:N derivation used the VISITING entity, not the DECLARING one.

``derive_m2m_fields`` classified the self-join, and matched the hetero junction
reference, against the ``source`` entity its CALLER passed. Every caller walks a
RESOLVING accessor — ``resolve_n2m_descriptor`` iterates ``source_entity.children()``,
``m2m_codegen.m2m_relationships`` iterates ``entity.children()`` — and passes the
entity it is iterating, so for a relationship inherited via ``extends`` that is the
INHERITING entity. An inherited self-join then read as hetero and raised; an
inherited hetero whose junction references the BASE raised too.

The fix accepts BOTH names of the relationship's subject — the declaring entity
(``rel.parent``) and the navigating entity — so the pre-existing shape (junction FK
references the CONCRETE child, pinned by ``test_n2m_resolver_inherited.py``) keeps
working. ``test_inherited_hetero_concrete_junction_reference`` below is the
counter-case that guards that.

Unlike the #368 loader passes there is no once-per-node ``checked`` set here, so the
defect is not gated on visit order — it is wrong for every inheriting entity in any
order. The fixtures still declare the child BEFORE the base and pin the root object
order, matching the #368 convention.
"""
from __future__ import annotations

import json

from metaobjects import InMemoryStringSource, MetaDataLoader, load_string
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.relationship.derive_m2m_fields import derive_m2m_fields
from metaobjects.meta.core.relationship.meta_relationship import MetaRelationship
from metaobjects.runtime.n2m_resolver import resolve_n2m_descriptor


def _entity(name: str, children: list[dict], **extra: object) -> dict:
    return {"object.entity": {"name": name, "children": children, **extra}}


def _pk(field: str = "id") -> dict:
    return {"identity.primary": {"name": field, "@fields": field}}


def _ref(name: str, fk: str, target: str) -> dict:
    return {"identity.reference": {"name": name, "@fields": fk, "@references": target}}


# Node extends NodeBase, which declares a @symmetric self-join onto ITSELF; the
# junction references the BASE. Node is declared FIRST (child before base).
SELF_JOIN = {
    "metadata.root": {
        "package": "acme",
        "children": [
            _entity("Node", [{"field.long": {"name": "id"}}, _pk()], extends="NodeBase"),
            _entity(
                "NodeBase",
                [
                    {
                        "relationship.association": {
                            "name": "peers",
                            "@cardinality": "many",
                            "@objectRef": "NodeBase",
                            "@through": "NodeLink",
                            "@symmetric": True,
                        }
                    }
                ],
                **{"@isAbstract": True},
            ),
            _entity(
                "NodeLink",
                [
                    {"field.long": {"name": "id"}},
                    {"field.long": {"name": "aId"}},
                    {"field.long": {"name": "bId"}},
                    _pk(),
                    _ref("aRef", "aId", "NodeBase"),
                    _ref("bRef", "bId", "NodeBase"),
                ],
            ),
        ],
    }
}

# Article extends ArticleBase; the junction references the BASE.
HETERO_BASE_REF = {
    "metadata.root": {
        "package": "acme",
        "children": [
            _entity("Article", [{"field.long": {"name": "id"}}, _pk()], extends="ArticleBase"),
            _entity(
                "ArticleBase",
                [
                    {
                        "relationship.association": {
                            "name": "tags",
                            "@cardinality": "many",
                            "@objectRef": "Tag",
                            "@through": "ArticleTag",
                        }
                    }
                ],
                **{"@isAbstract": True},
            ),
            _entity("Tag", [{"field.long": {"name": "id"}}, _pk()]),
            _entity(
                "ArticleTag",
                [
                    {"field.long": {"name": "id"}},
                    {"field.long": {"name": "articleId"}},
                    {"field.long": {"name": "tagId"}},
                    _pk(),
                    _ref("aRef", "articleId", "ArticleBase"),
                    _ref("tRef", "tagId", "Tag"),
                ],
            ),
        ],
    }
}

# The OTHER legitimate shape: the junction references the CONCRETE child.
HETERO_CONCRETE_REF = {
    "metadata.root": {
        "package": "acme",
        "children": [
            _entity("Post", [{"field.long": {"name": "id"}}, _pk()], extends="PostBase"),
            _entity(
                "PostBase",
                [
                    {
                        "relationship.association": {
                            "name": "tags",
                            "@cardinality": "many",
                            "@objectRef": "Tag",
                            "@through": "PostTag",
                        }
                    }
                ],
                **{"@isAbstract": True},
            ),
            _entity("Tag", [{"field.long": {"name": "id"}}, _pk()]),
            _entity(
                "PostTag",
                [
                    {"field.long": {"name": "id"}},
                    {"field.long": {"name": "postId"}},
                    {"field.long": {"name": "tagId"}},
                    _pk(),
                    _ref("pRef", "postId", "Post"),
                    _ref("tRef", "tagId", "Tag"),
                ],
            ),
        ],
    }
}


def _index(meta: dict) -> dict[str, MetaObject]:
    root = load_string(json.dumps(meta)).root
    return {c.name: c for c in root.children() if isinstance(c, MetaObject)}


def _rel(entity: MetaObject, name: str) -> MetaRelationship:
    for c in entity.children():
        if isinstance(c, MetaRelationship) and c.name == name:
            return c
    raise AssertionError(f"no relationship {name} on {entity.name}")


def test_inherited_self_join_derives_both_fk_sides() -> None:
    index = _index(SELF_JOIN)
    # Pin the premise: the child is reached before the base it inherits from.
    assert list(index) == ["Node", "NodeBase", "NodeLink"]
    node = index["Node"]
    rel = _rel(node, "peers")
    # Genuinely inherited — not one of Node's own children.
    assert "peers" not in {c.name for c in node.own_children()}
    assert rel.parent is not None and rel.parent.name == "NodeBase"

    fields = derive_m2m_fields(rel, node, index)
    assert fields.source_field == "aId"
    assert fields.target_field == "bId"
    # The declaring entity itself must agree — same node, same answer.
    assert derive_m2m_fields(rel, index["NodeBase"], index) == fields


def test_inherited_hetero_matches_the_declaring_bases_reference() -> None:
    index = _index(HETERO_BASE_REF)
    assert list(index) == ["Article", "ArticleBase", "Tag", "ArticleTag"]
    fields = derive_m2m_fields(_rel(index["Article"], "tags"), index["Article"], index)
    assert fields.source_field == "articleId"
    assert fields.target_field == "tagId"


def test_inherited_hetero_concrete_junction_reference() -> None:
    """Counter-case: accepting ONLY the declaring entity would break this shape."""
    index = _index(HETERO_CONCRETE_REF)
    rel = _rel(index["Post"], "tags")
    assert rel.parent is not None and rel.parent.name == "PostBase"
    fields = derive_m2m_fields(rel, index["Post"], index)
    assert fields.source_field == "postId"
    assert fields.target_field == "tagId"


def test_runtime_resolver_traverses_an_inherited_self_join() -> None:
    """The runtime path re-raises the derivation error, so an inherited self-join
    was untraversable at run time, not merely dropped from generated code."""
    index = _index(SELF_JOIN)
    desc = resolve_n2m_descriptor(index["Node"], "peers", index)
    assert desc is not None
    assert desc.source_entity_name == "Node"
    assert desc.source_field == "aId"
    assert desc.target_field == "bId"
    assert desc.symmetric is True

# The Python codegen path (``m2m_codegen.resolve_m2m_descriptors``) calls the same
# SSOT and so is fixed transitively; it is not exercised here because it additionally
# requires a physical ``source.rdb`` on the junction and target, which an abstract
# declaring base does not have — a separate concern from the derivation.


# REGRESSION — a cross-package hetero M:N must not be read as a self-join just because
# the target's SHORT name matches one of the subject's.
#
# ``a::NodeBase`` declares a genuine cross-package hetero M:N onto ``b::NodeBase``, and
# ``a::Node`` extends ``a::NodeBase``. Deriving from ``a::Node`` the subject is
# {a::NodeBase, a::Node}; under the old package-stripped compare "b::NodeBase" stripped
# to "NodeBase", landed in the subject set, and the relationship refused to derive as an
# ambiguous self-join. It had derived correctly before the subject set grew to two names,
# so that was a regression, not a pre-existing gap.
#
# Fixed by comparing RESOLVED OBJECT IDENTITY, which is what the Java port has always
# done — this is the Python half of the pair with
# M2MSlimVocabularyTest.deriveCrossPackageHeteroBindsCorrectPackage, and it REDUCES the
# cross-port divergence rather than pinning it.
XPKG_A = {
    "metadata.root": {
        "package": "a",
        "children": [
            _entity("Node", [{"field.long": {"name": "id"}}, _pk()], extends="a::NodeBase"),
            _entity(
                "NodeBase",
                [
                    {
                        "relationship.association": {
                            "name": "links",
                            "@cardinality": "many",
                            "@objectRef": "b::NodeBase",
                            "@through": "L",
                        }
                    }
                ],
                **{"@isAbstract": True},
            ),
            _entity(
                "L",
                [
                    {"field.long": {"name": "srcId"}},
                    {"field.long": {"name": "dstId"}},
                    {"identity.primary": {"name": "id", "@fields": ["srcId", "dstId"]}},
                    _ref("s", "srcId", "a::Node"),
                    _ref("d", "dstId", "b::NodeBase"),
                ],
            ),
        ],
    }
}

XPKG_B = {
    "metadata.root": {
        "package": "b",
        "children": [_entity("NodeBase", [{"field.long": {"name": "id"}}, _pk()])],
    }
}


def test_cross_package_target_sharing_a_subject_short_name_is_not_a_self_join() -> None:
    """Identity resolution keeps this hetero, exactly as Java does."""
    result = MetaDataLoader().load([
        InMemoryStringSource(json.dumps(XPKG_A), id="a.json"),
        InMemoryStringSource(json.dumps(XPKG_B), id="b.json"),
    ])
    # The model itself is perfectly legal — the loader raises nothing.
    assert result.errors == []
    root = result.root
    objects = [c for c in root.children() if isinstance(c, MetaObject)]
    # Pin the premise: the child is reached before the base it inherits from.
    assert [o.name for o in objects] == ["Node", "NodeBase", "L", "NodeBase"]
    index = {o.name: o for o in objects}
    node = objects[0]
    rel = _rel(node, "links")
    fields = derive_m2m_fields(rel, node, index)
    assert fields.source_field == "srcId"
    assert fields.target_field == "dstId"
