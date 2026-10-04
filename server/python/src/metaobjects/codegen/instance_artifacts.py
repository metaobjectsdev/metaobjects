"""Guard for the abstract concept (mirrors the TS instance-artifacts module).

An abstract entity must never produce instance/write artifacts (routers, filter
allowlists, CREATE TABLE DDL). The Pydantic base *model* is a separate concern: this
port ALWAYS emits it (concretes subclass it). It was described here as "a configurable
shape concern (emit_abstract_shapes, default on) handled in entity_model" — that config
field was read by nothing and entity_model never consulted it, so `GenConfig` now
refuses to accept a value it cannot honour.
"""
from metaobjects.meta.core.identity.identity_constants import IDENTITY_ATTR_FIELDS
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_REPORT
from metaobjects.meta.core.reporting.report_read_model import report_read_source
from metaobjects.meta.persistence.source.source_constants import SOURCE_KIND_VIEW


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


def is_served_report(obj: MetaObject) -> bool:
    """FR-044 Table A: an ``object.report`` is SERVED (gets a row model, a filter
    allowlist, a read-only router and a names module) iff it is concrete and its read
    source (:func:`report_read_source`) has ``@kind: view``. A sourceless report, an
    abstract one, and one over a ``materializedView`` / ``storedProc`` / ``tableFunction``
    are not: the lowering skips those kinds, so no relation with Table B's columns is
    promised.

    Answers the same for a declared report and for its read model (which keeps the
    ``object.report`` subtype and carries a copy of the read source as its only source).
    """
    if obj.sub_type != OBJECT_SUBTYPE_REPORT or is_abstract(obj):
        return False
    source = report_read_source(obj)
    return source is not None and source.effective_kind() == SOURCE_KIND_VIEW


def has_item_route(entity: MetaObject) -> bool:
    """Whether a read-only object is addressable by key: it has a primary identity over
    EXACTLY ONE field. A report has no identity at all, and a keyless projection has none
    either, so neither gets a ``/{id}`` route or a ``find_by_id`` on its repository seam
    (FR-044 open question 4). A composite identity has no single path parameter to bind."""
    identity = entity.primary_identity()
    if identity is None:
        return False
    fields = identity.get_meta_attr(IDENTITY_ATTR_FIELDS)  # ADR-0039: resolving (identity attr)
    if isinstance(fields, str):
        names = [n for n in (p.strip() for p in fields.split(",")) if n]
    elif isinstance(fields, (list, tuple)):
        names = [n for n in fields if isinstance(n, str) and n]
    else:
        names = []
    return len(names) == 1
