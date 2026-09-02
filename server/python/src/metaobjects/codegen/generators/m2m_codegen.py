"""Shared M:N (many-to-many) codegen descriptor — the build-time resolution of a
source entity's ``relationship.* @cardinality:"many" + @through`` children into
the concrete coordinates each Python generator needs (Pydantic nested collection,
FastAPI traversal route, and the physical junction/target column names the
repository seam joins on).

This mirrors the TS reference ``relation-resolver.ts`` (Unit 10): codegen derives
the descriptor at build time from the junction entity's two ``identity.reference``
children (the cross-port SSOT for FK direction) via the shared
``derive_m2m_fields`` helper — the relationship never restates its FK columns.

The descriptor carries:
  * ``relation_name`` — the navigation member name (route segment + Pydantic field).
  * ``target_entity`` — the related entity's bare name (Pydantic element type).
  * ``source_plural`` / ``target_plural`` — pluralized entity names for the
    REST contract: the source URL segment is the ENTITY name pluralized
    (``Person`` → ``persons``), NOT the physical ``@table`` (cross-port grammar).
  * ``source_column`` / ``target_column`` — the PHYSICAL junction FK columns
    (e.g. ``follower_id`` / ``followee_id``); the repository seam joins on these.
  * ``junction_table`` / ``target_table`` / ``target_pk_column`` — physical names
    for the join.
  * ``symmetric`` — selects the union-on-read traversal.
"""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.source_resolution import resolve_table_name
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.naming import (
    DEFAULT_COLUMN_NAMING,
    apply_column_naming_strategy,
    resolve_column_name,
)
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.core.identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_SUBTYPE_PRIMARY,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.relationship.derive_m2m_fields import (
    M2MDerivationError,
    derive_m2m_fields,
)
from metaobjects.meta.core.relationship.meta_relationship import MetaRelationship
from metaobjects.meta.core.relationship.relationship_constants import CARDINALITY_MANY
from metaobjects.shared.base_types import TYPE_IDENTITY
from metaobjects.shared.separators import PACKAGE_SEP


@dataclass(frozen=True)
class M2mDescriptor:
    """Build-time coordinates of one M:N navigation on a source entity."""

    relation_name: str
    target_entity: str
    source_plural: str
    target_plural: str
    junction_table: str
    target_table: str
    source_column: str
    target_column: str
    target_pk_column: str
    symmetric: bool


def _strip_package(name: str) -> str:
    idx = name.rfind(PACKAGE_SEP)
    return name[idx + len(PACKAGE_SEP):] if idx >= 0 else name


def plural_lowercase(name: str) -> str:
    """``Person`` → ``persons``. Cross-port-aligned trivial pluralization — the
    SOURCE URL segment is the entity name pluralized, NOT the physical table."""
    return name.lower() + "s"


def _physical_table(entity: MetaObject, *, relation_context: str) -> str:
    """The entity's physical SQL table name, via the shared
    :func:`~metaobjects.source_resolution.resolve_table_name` resolver.

    Raises :class:`M2MDerivationError` — naming *entity* and *relation_context*
    — when it declares (and inherits) no primary source at all. #248: DB
    participation derives from a declared source, never from the object
    subtype, so ``resolve_table_name`` returning ``None`` here means the
    junction/target has no physical table to join through at all; a M:N
    relationship's whole point is a real SQL join, so that is a metadata
    authoring error, not a legitimate "doesn't participate in persistence"
    shape. Coercing to the bare entity name — the pre-existing behaviour this
    replaces — fabricated a table that was never created, precisely the defect
    class the C# port's EF binding had to fix this same session (a
    ``[Table(...)]`` attribute naming a class that was never generated)."""
    table = resolve_table_name(entity)
    if table is None:
        raise M2MDerivationError(
            f"{relation_context}: entity \"{entity.name}\" declares no primary "
            f"source (source.rdb) — a M:N join needs a physical table on both "
            f"the junction and the target."
        )
    return table


def _column_of(
    field: MetaField | None, fallback: str, strategy: str = DEFAULT_COLUMN_NAMING
) -> str:
    """Physical column name for a junction FK. Delegates to the shared
    :func:`metaobjects.naming.resolve_column_name` — the SAME resolver the runtime uses,
    so generated junction SQL and runtime SQL cannot disagree about a column name.

    *fallback* covers the case where the field could not be resolved at all; it is a
    bare metadata name, so it goes through the strategy too."""
    if field is None:
        return apply_column_naming_strategy(fallback, strategy)
    return resolve_column_name(field, strategy)


def _field_named(entity: MetaObject, field_name: str) -> MetaField | None:
    for f in entity.fields():
        if f.name == field_name:
            return f
    return None


def pk_field_name(entity: MetaObject) -> str:
    """The single PK field name (``identity.primary @fields``), default ``id``."""
    for c in entity.children():
        if c.type == TYPE_IDENTITY and c.sub_type == IDENTITY_SUBTYPE_PRIMARY:
            fields = c.get_meta_attr(IDENTITY_ATTR_FIELDS)  # ADR-0039: resolving (identity attr)
            if isinstance(fields, (list, tuple)) and fields:
                first = fields[0]
                if isinstance(first, str):
                    return first
            if isinstance(fields, str) and fields:
                return fields.split(",")[0].strip() or "id"
    return "id"


def m2m_relationships(entity: MetaObject) -> list[MetaRelationship]:
    """The entity's ``relationship.* @cardinality:"many" + @through`` children
    (declaration order). 1:N relationships (no ``@through``) are excluded.

    ADR-0039 — RESOLVING (children()): mirrors the TS ``relationships()`` (built on
    the effective ``children()``); a relationship inherited via ``extends`` counts.
    """
    out: list[MetaRelationship] = []
    for c in entity.children():
        if not isinstance(c, MetaRelationship):
            continue
        if c.cardinality() != CARDINALITY_MANY:
            continue
        if c.through() is None:
            continue
        out.append(c)
    return out


def resolve_m2m_descriptors(
    entity: MetaObject,
    object_index: dict[str, MetaObject],
    column_naming: str = DEFAULT_COLUMN_NAMING,
) -> list[M2mDescriptor]:
    """Resolve every M:N navigation on *entity* into a build-time descriptor.

    *object_index* is a bare-name → entity map of the loaded model. A relationship
    that fails derivation (missing/malformed junction, ambiguous self-join) raises
    :class:`M2MDerivationError` — the loader validates this; reaching it here is a
    metadata error, surfaced loudly (never silently skipped).
    """
    descriptors: list[M2mDescriptor] = []
    for rel in m2m_relationships(entity):
        target_name = _strip_package(rel.object_ref() or "")
        junction_name = _strip_package(rel.through() or "")
        target = object_index.get(target_name)
        junction = object_index.get(junction_name)
        if target is None or junction is None:
            raise M2MDerivationError(
                f'M:N relationship "{entity.name}.{rel.name}": @objectRef '
                f'"{target_name}" / @through "{junction_name}" must resolve to '
                f"loaded entities"
            )

        # Widen to dict[str, MetaData] for the shared derivation helper (dict is
        # invariant; MetaObject is a MetaData subtype).
        meta_index: dict[str, MetaData] = dict(object_index)
        fields = derive_m2m_fields(rel, entity, meta_index)
        source_fk = _field_named(junction, fields.source_field)
        target_fk = _field_named(junction, fields.target_field)

        descriptors.append(
            M2mDescriptor(
                relation_name=rel.name,
                target_entity=target.name,
                source_plural=plural_lowercase(entity.name),
                target_plural=plural_lowercase(target.name),
                junction_table=_physical_table(
                    junction,
                    relation_context=(
                        f'M:N relationship "{entity.name}.{rel.name}" @through junction'
                    ),
                ),
                target_table=_physical_table(
                    target,
                    relation_context=(
                        f'M:N relationship "{entity.name}.{rel.name}" @objectRef target'
                    ),
                ),
                source_column=_column_of(source_fk, fields.source_field, column_naming),
                target_column=_column_of(target_fk, fields.target_field, column_naming),
                target_pk_column=_column_of(
                    _field_named(target, pk_field_name(target)),
                    pk_field_name(target),
                    column_naming,
                ),
                symmetric=rel.symmetric(),
            )
        )
    return descriptors


def build_object_index(entities: list[MetaObject]) -> dict[str, MetaObject]:
    """Bare-name → entity map (the codegen resolution surface, mirroring the
    runtime resolver's ``object_index``)."""
    return {e.name: e for e in entities}
