"""Collection-name collision refusal — the single choke point every route/router/
finder generator path goes through (called once, in ``run_gen``, over the full
entity set BEFORE any generator runs).

Two DISTINCT entities/projections pluralizing to the SAME API-surface collection
name (REST path, generated router module/finder names) is reachable from stock
metadata now that :func:`metaobjects.apidocs.naming.pluralize` no longer doubles an
already-plural word: ``Address`` (not already-plural: legacy-pluralizes to
``Addresses``) and ``Addresses`` (already-plural: left unchanged, ALSO
``Addresses``) collide, where before the fix they did not (``Addresses`` legacy-
pluralized to ``Addresseses``). Silently letting two entities share one collection
name would mean whichever generator runs second silently wins, or a straight
duplicate-module/route registration two files downstream of the real cause. This
refuses at the one place that can see the WHOLE set, with a message naming both
entities and the colliding name.
"""
from __future__ import annotations

from metaobjects.apidocs.naming import pluralize, route_path
from metaobjects.errors import ErrorCode
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_VALUE
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.runtime.tph import tph_subtype_of

from .instance_artifacts import is_abstract

ERR_COLLECTION_NAME_COLLISION = ErrorCode.ERR_COLLECTION_NAME_COLLISION.value


def assert_no_collection_name_collisions(entities: list[MetaObject]) -> None:
    """Refuse a generation run in which two DISTINCT entities/projections pluralize
    to the same API-surface collection name.

    Scope: every object EXCEPT ``object.value`` (a value object never gets a route,
    router module, or finder name — it is pure shape, so it cannot collide on any of
    those). A TPH subtype IS included: it gets its own generated names against the
    shared base table, so two subtypes (or a subtype and an unrelated top-level
    entity) sharing a pluralized name collide on those generated symbols exactly as
    two top-level entities would.

    A PURE function of the entity set — never of traversal order: the reported pair
    is deterministic (first-seen-by-input-order "owner" of a plural; raised as soon
    as a second, different entity claims the same plural).
    """
    owner_of_plural: dict[str, MetaObject] = {}
    for obj in entities:
        if obj.sub_type == OBJECT_SUBTYPE_VALUE:
            continue
        plural = pluralize(obj.name)
        existing = owner_of_plural.get(plural)
        if existing is not None:
            if existing.resolution_key() != obj.resolution_key():
                raise ValueError(
                    f"{ERR_COLLECTION_NAME_COLLISION}: \"{existing.name}\" and \"{obj.name}\" both "
                    f'pluralize to the API-surface collection name "{plural}" (REST path, generated '
                    "router module/finder names) — rename one entity so its pluralized name is "
                    "distinct. Default PHYSICAL table names are unaffected by this rule and are not "
                    "involved in the collision."
                )
        else:
            owner_of_plural[plural] = obj
    _assert_no_route_segment_collisions(entities)


def _assert_no_route_segment_collisions(entities: list[MetaObject]) -> None:
    """The route half. The REST segment is the entity NAME snake_cased and then
    pluralized (:func:`route_path`), so ``ApiKey`` and ``APIKey`` both serve
    ``/api_keys`` while their pluralized names differ and pass the check above.
    Counts only objects that actually get a route: not a value object, not abstract,
    not sourceless, not a TPH subtype (folded into its base and served under it)."""
    owner_of_segment: dict[str, MetaObject] = {}
    for obj in entities:
        if obj.sub_type == OBJECT_SUBTYPE_VALUE or is_abstract(obj):
            continue
        # ADR-0039: children() resolves — an inherited source still gets a route.
        if not any(isinstance(c, MetaSource) for c in obj.children()):
            continue
        if tph_subtype_of(obj) is not None:
            continue
        segment = route_path(obj.name)
        existing = owner_of_segment.get(segment)
        if existing is None:
            owner_of_segment[segment] = obj
        elif existing.resolution_key() != obj.resolution_key():
            raise ValueError(
                f'{ERR_COLLECTION_NAME_COLLISION}: "{existing.name}" and "{obj.name}" both resolve '
                f'to the REST collection segment "{segment}" — rename one entity so its '
                "snake_cased, pluralized route segment is distinct."
            )
