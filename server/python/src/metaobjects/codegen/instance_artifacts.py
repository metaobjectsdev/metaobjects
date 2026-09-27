"""Guard for the abstract concept (mirrors the TS instance-artifacts module).

An abstract entity must never produce instance/write artifacts (routers, filter
allowlists, CREATE TABLE DDL). The Pydantic base *model* is a separate concern: this
port ALWAYS emits it (concretes subclass it). It was described here as "a configurable
shape concern (emit_abstract_shapes, default on) handled in entity_model" — that config
field was read by nothing and entity_model never consulted it, so `GenConfig` now
refuses to accept a value it cannot honour.
"""
from metaobjects.meta.core.object.meta_object import MetaObject


def is_abstract(entity: MetaObject) -> bool:
    return entity.is_abstract is True


def emits_instance_artifacts(entity: MetaObject) -> bool:
    return not is_abstract(entity)


def is_sourceless_entity(entity: MetaObject) -> bool:
    """A record whose store MetaObjects does not manage: a concrete object with a primary
    identity and no ``source.*`` at all, declared or inherited (a MongoDB collection, a
    Cassandra table, a Neo4j node, a remote API). #248 gives it no router, table or
    migration; the adopter owns the data access.

    It still has a wire contract, because the identity makes it addressable: a client can
    create, fetch and PATCH it. So it gets the filter allowlist its own list endpoint needs
    (the Create/Patch models come from the entity generator already).

    Keyed on the identity, not the object subtype (#248): ADR-0028 forbids a value object
    any identity. The projection exclusion is ADR-0028's own rule — a projection is
    read-only because of its subtype. Mirrors the TypeScript ``isSourcelessEntity``.
    """
    from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_PROJECTION
    from metaobjects.meta.persistence.source.meta_source import MetaSource

    if is_abstract(entity) or entity.sub_type == OBJECT_SUBTYPE_PROJECTION:
        return False
    if entity.primary_identity() is None:
        return False
    # ADR-0039: children() resolves — an inherited source makes the object persistable.
    return not any(isinstance(c, MetaSource) for c in entity.children())
