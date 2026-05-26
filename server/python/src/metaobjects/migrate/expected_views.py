"""Build view bodies from projection metadata (origins).

Port of TS expected-views.ts / Java ViewBodyBuilder. v1 supports passthrough
(no @via) + aggregate (@agg/@of/@via). Deferred to v2 (returns None →
caller drops the view from the snapshot): passthrough WITH @via, collection,
multi-base.

Identifiers quoted throughout so mixed-case columns (e.g. "programId")
round-trip through PG's case-fold.
"""
from __future__ import annotations

from ..meta.meta_root import MetaRoot
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.identity.meta_identity import MetaIdentity
from ..meta.core.identity import identity_constants as ic
from ..meta.core.field.meta_field import MetaField
from ..meta.core.field import field_constants as fc
from ..meta.core.relationship.meta_relationship import MetaRelationship
from ..meta.persistence.source.meta_source import MetaSource
from ..meta.persistence.source import source_constants as sc
from ..meta.persistence.origin.meta_origin import MetaOrigin
from ..meta.persistence.origin import origin_constants as oc
from .types import ViewDescriptor


def build_expected_views(root: MetaRoot, entity_by_name: dict[str, MetaObject]) -> list[ViewDescriptor]:
    out: list[ViewDescriptor] = []
    for child in root.own_children():
        if not isinstance(child, MetaObject):
            continue
        primary = _primary_read_only_source(child)
        if primary is None or primary.table_name() is None:
            continue
        # Skip write-through (has both writable AND read-only sources).
        if _primary_writable_source(child) is not None:
            continue
        body = _build_view_body(child, entity_by_name)
        if body is None:
            continue
        out.append(ViewDescriptor(name=primary.table_name(), schema=primary.schema(), sql=body))
    return out


def _build_view_body(projection: MetaObject, entity_by_name: dict[str, MetaObject]) -> str | None:
    """Compute the SELECT body, or None when unresolvable."""
    cols: list[str] = []
    base_entity: str | None = None
    T = "t"  # alias inside correlated subqueries

    for f in projection.fields():
        origin = _first_origin(f)
        if origin is None:
            return None
        field_col = _column_of(f)

        # passthrough (no @via) → plain column off the single base
        if origin.sub_type == oc.ORIGIN_SUBTYPE_PASSTHROUGH and origin.attr(oc.ORIGIN_ATTR_VIA) is None:
            from_attr = origin.attr(oc.ORIGIN_ATTR_FROM)
            if not isinstance(from_attr, str) or "." not in from_attr:
                return None
            ent, fname = from_attr.split(".", 1)
            bare = _strip_pkg(ent)
            if base_entity is None:
                base_entity = bare
            elif base_entity != bare:
                return None  # multi-base — deferred
            src = entity_by_name.get(base_entity)
            src_col = _column_for(src, fname)
            cols.append(f'  "{src_col}" AS "{field_col}"')
        # aggregate (@agg/@of/@via) → correlated subquery over a to-many
        elif origin.sub_type == oc.ORIGIN_SUBTYPE_AGGREGATE:
            agg = origin.attr(oc.ORIGIN_ATTR_AGG)
            of_attr = origin.attr(oc.ORIGIN_ATTR_OF)
            via = origin.attr(oc.ORIGIN_ATTR_VIA)
            if not (isinstance(agg, str) and isinstance(of_attr, str) and isinstance(via, str)
                    and "." in of_attr and "." in via):
                return None
            base_ent, rel_name = via.split(".", 1)
            bare = _strip_pkg(base_ent)
            if base_entity is None:
                base_entity = bare
            elif base_entity != bare:
                return None
            fk = _resolve_to_many_fk(entity_by_name, base_entity, rel_name)
            if fk is None:
                return None
            of_col = _column_for(fk.target, of_attr.split(".", 1)[1])
            base_table = _base_table(entity_by_name, base_entity)
            cols.append(
                f'  (SELECT {agg}({T}."{of_col}") FROM "{fk.target_table}" {T} '
                f'WHERE {T}."{fk.fk_col}" = "{base_table}"."{fk.parent_col}") AS "{field_col}"'
            )
        else:
            # passthrough WITH via OR collection — deferred
            return None

    if base_entity is None or not cols:
        return None
    return "SELECT\n" + ",\n".join(cols) + f'\nFROM "{_base_table(entity_by_name, base_entity)}"'


# ----------------------------------------------------------------------------
# To-many FK resolution
# ----------------------------------------------------------------------------


class _ToManyFk:
    """(target_entity, target_table, fk-col-on-target, parent-pk-col-on-base)."""
    __slots__ = ("target", "target_table", "fk_col", "parent_col")

    def __init__(self, target: MetaObject, target_table: str, fk_col: str, parent_col: str) -> None:
        self.target = target
        self.target_table = target_table
        self.fk_col = fk_col
        self.parent_col = parent_col


def _resolve_to_many_fk(
    entity_by_name: dict[str, MetaObject], base_entity_name: str, rel_name: str,
) -> _ToManyFk | None:
    base_obj = entity_by_name.get(base_entity_name)
    if base_obj is None:
        return None
    rel = next(
        (r for r in base_obj.children() if isinstance(r, MetaRelationship) and r.name == rel_name),
        None,
    )
    if rel is None or rel.object_ref() is None:
        return None
    target = entity_by_name.get(_strip_pkg(rel.object_ref()))
    if target is None:
        return None
    target_primary = _primary_writable_source(target)
    if target_primary is None or target_primary.table_name() is None:
        return None

    # Find the target's ReferenceIdentity pointing back at base_entity_name.
    fk_ref: MetaIdentity | None = None
    for c in target.children():
        if not isinstance(c, MetaIdentity) or c.sub_type != ic.IDENTITY_SUBTYPE_REFERENCE:
            continue
        ref = c.attr(ic.IDENTITY_REFERENCE_ATTR_REFERENCES)
        if isinstance(ref, str) and _strip_pkg(ref.split(".", 1)[0]) == base_entity_name:
            fk_ref = c
            break
    if fk_ref is None:
        return None
    fk_fields = _identity_fields(fk_ref)
    if not fk_fields:
        return None
    fk_col = _column_for(target, fk_fields[0])

    # Parent column on base — explicit target field else PK first field
    ref_attr = fk_ref.attr(ic.IDENTITY_REFERENCE_ATTR_REFERENCES)
    if isinstance(ref_attr, str) and "." in ref_attr:
        parent_field = ref_attr.split(".", 1)[1]
    else:
        pi = base_obj.primary_identity()
        parent_field = _identity_fields(pi)[0] if pi is not None and _identity_fields(pi) else "id"
    parent_col = _column_for(base_obj, parent_field)
    return _ToManyFk(target=target, target_table=target_primary.table_name(), fk_col=fk_col, parent_col=parent_col)


# ----------------------------------------------------------------------------
# Helpers (shared with expected_schema.py — duplicated to avoid a cycle)
# ----------------------------------------------------------------------------


def _first_origin(f: MetaField) -> MetaOrigin | None:
    for c in f.own_children():
        if isinstance(c, MetaOrigin):
            return c
    return None


def _identity_fields(identity: MetaIdentity) -> tuple[str, ...]:
    raw = identity.attr(ic.IDENTITY_ATTR_FIELDS)
    if raw is None:
        return ()
    if isinstance(raw, str):
        return (raw,)
    if isinstance(raw, (list, tuple)):
        return tuple(str(x) for x in raw)
    return ()


def _column_of(field: MetaField) -> str:
    col = field.attr(fc.FIELD_ATTR_COLUMN)
    return col if isinstance(col, str) and col else field.name


def _column_for(entity: MetaObject | None, field_name: str) -> str:
    if entity is None:
        return field_name
    f = entity.find_field(field_name)
    return _column_of(f) if f is not None else field_name


def _primary_writable_source(entity: MetaObject) -> MetaSource | None:
    for child in entity.own_children():
        if isinstance(child, MetaSource) and child.role() == sc.SOURCE_ROLE_PRIMARY and child.is_writable():
            return child
    return None


def _primary_read_only_source(entity: MetaObject) -> MetaSource | None:
    for child in entity.own_children():
        if isinstance(child, MetaSource) and child.role() == sc.SOURCE_ROLE_PRIMARY and child.is_read_only():
            return child
    return None


def _base_table(entity_by_name: dict[str, MetaObject], entity_name: str) -> str:
    e = entity_by_name.get(entity_name)
    if e is None:
        return entity_name
    p = _primary_writable_source(e)
    return p.table_name() if (p and p.table_name()) else entity_name


def _strip_pkg(name: str) -> str:
    idx = name.rfind("::")
    return name if idx == -1 else name[idx + 2 :]
