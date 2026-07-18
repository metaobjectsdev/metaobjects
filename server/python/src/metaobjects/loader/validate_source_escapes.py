"""#208 — DDL-ownership escape valves loader validation (source.rdb @sql / @unmanaged).

Sibling of validate_source_parameter_ref.py / validate_source_physical_names.py.

#208 gives source.rdb two mutually exclusive, non-default DDL-ownership
markers: ``@sql`` (a hand-written body the tool registers/fingerprints/drift-
checks but never authors) and ``@unmanaged`` (this object's DDL is owned
elsewhere — the tool never touches it). This pass enforces the six
fail-closed rules from the design doc (§5):

    R1  @sql AND @unmanaged on the SAME source          -> ERR_SQL_BODY_WITH_UNMANAGED
    R2  @sql on a writable @kind ("table", the default)  -> ERR_SQL_BODY_ON_WRITABLE_KIND
    R3  @sql present but empty / whitespace-only         -> ERR_BAD_ATTR_VALUE
    R4  origin.*-bearing field under an @sql host         -> ERR_ORIGIN_UNDER_SQL_BODY
    R5  object.projection @filter (#207) + @sql host      -> ERR_ORIGIN_UNDER_SQL_BODY
    R6  origin.*-bearing field under an @unmanaged host    -> WARN_ORIGIN_UNDER_UNMANAGED

R1-R3 are per-source (declaration-layer). R4-R6 are per-host-object: a host
with ANY own source.rdb carrying @sql/@unmanaged is judged against its own
fields (and, for R5, its own @filter). The asymmetry between R4 (hard error)
and R6 (warn) is deliberate (design doc §5.6): @sql is a second body (two
sources of truth for the SAME data); @unmanaged acts on nothing, so a
documented-but-unacted-on lineage is benign.

Mirrors the TS reference
``packages/typescript/packages/metadata/src/persistence/source/validate-source-escapes.ts``.
"""
from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.core.field.meta_field import MetaField
from ..meta.core.object.object_constants import (
    OBJECT_PROJECTION_ATTR_FILTER,
    OBJECT_SUBTYPE_PROJECTION,
)
from ..meta.meta_data import MetaData
from ..meta.persistence.source.meta_source import MetaSource
from ..meta.persistence.source.source_constants import (
    SOURCE_ATTR_SQL,
    SOURCE_SUBTYPE_RDB,
)
from ..shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_SOURCE
from ..source.error_source import LoaderWarning

WARN_ORIGIN_UNDER_UNMANAGED = "WARN_ORIGIN_UNDER_UNMANAGED"


def validate_source_escapes(
    root: MetaData,
    errors: list[MetaError],
    envelope_warnings: list[LoaderWarning] | None = None,
    legacy_warnings: list[str] | None = None,
) -> None:
    """Run the #208 R1-R6 @sql / @unmanaged DDL-ownership validation.

    ``envelope_warnings`` collects the FR5c-style envelope warning
    (``WARN_ORIGIN_UNDER_UNMANAGED``, R6). ``legacy_warnings`` mirrors the
    cross-port string warnings channel — populated with the same code string
    so the legacy ``warnings: list[str]`` consumers see something too.
    """
    # ADR-0039 sanctioned own: root has no super (children()==own_children()),
    # and every object is declared at the root level (mirrors the TS
    # reference's root.children() walk).
    for obj in root.own_children():
        if obj.type != TYPE_OBJECT:
            continue

        # ADR-0039 sanctioned own: declaration-layer source iteration (mirrors
        # validate_source_parameter_ref / _validate_one_primary_source):
        # R1-R3 judge markers DECLARED on this object's own sources.
        sources = [
            c
            for c in obj.own_children()
            if c.type == TYPE_SOURCE
            and c.sub_type == SOURCE_SUBTYPE_RDB
            and isinstance(c, MetaSource)
        ]

        has_sql_host = False
        has_unmanaged_host = False

        for source in sources:
            # ADR-0039: resolving — @sql/@unmanaged are inheritable (follow
            # the @role/effective_kind precedent — sources are inheritable,
            # NOT the @dbColumnType own-only exception).
            sql_set = source.sql_body() is not None
            unmanaged_set = source.is_unmanaged()

            # R1 — contradictory DDL owners on the same source.
            if sql_set and unmanaged_set:
                errors.append(
                    MetaError(
                        f'source.rdb on object "{obj.name}" declares both @sql and '
                        "@unmanaged — these are the mutually exclusive non-default "
                        "states of one DDL-ownership axis (an author-supplied body "
                        'contradicts "someone else owns this DDL")',
                        ErrorCode.ERR_SQL_BODY_WITH_UNMANAGED,
                        envelope=source.source,
                    )
                )

            # R2 — @sql on a writable kind would bypass the column-diff
            # machinery; tables are fully modeled or @unmanaged, never
            # opaque-bodied.
            if sql_set and source.is_writable():
                errors.append(
                    MetaError(
                        f'source.rdb on object "{obj.name}" declares @sql with a '
                        f'writable @kind ("{source.effective_kind()}") — @sql is '
                        "legal only on a read-only kind (view/materializedView/"
                        "storedProc/tableFunction); a writable table is either "
                        "fully modeled or marked @unmanaged, never opaque-bodied",
                        ErrorCode.ERR_SQL_BODY_ON_WRITABLE_KIND,
                        envelope=source.source,
                    )
                )

            # R3 — @sql present but empty/whitespace. MUST read the raw attr,
            # not the sql_body() accessor: sql_body() already narrows an
            # empty string to None, which would make a present-but-empty
            # @sql indistinguishable from an absent one.
            raw_sql = source.get_meta_attr(SOURCE_ATTR_SQL)
            if raw_sql is not None and (
                not isinstance(raw_sql, str) or raw_sql.strip() == ""
            ):
                errors.append(
                    MetaError(
                        f'source.rdb on object "{obj.name}" sets @sql to an '
                        "empty/whitespace-only value; @sql requires a non-empty "
                        "SQL body",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        envelope=source.source,
                    )
                )

            if sql_set:
                has_sql_host = True
            if unmanaged_set:
                has_unmanaged_host = True

        if not has_sql_host and not has_unmanaged_host:
            continue

        # R4 / R6 — origin.*-bearing (derived) own fields under an @sql /
        # @unmanaged host. ADR-0039: own — origin.* never inherits
        # (ADR-0029), so is_derived() is own-only by policy (mirrors
        # _validate_derived_field_providability). @sql (hard error) takes
        # priority over @unmanaged (warn) when a host happens to declare
        # both markers across different sources.
        for child in obj.own_children():
            if child.type != TYPE_FIELD or not isinstance(child, MetaField):
                continue
            if not child.is_derived():
                continue
            if has_sql_host:
                errors.append(
                    MetaError(
                        f'field "{obj.name}.{child.name}" carries an origin.* '
                        f'(derived) child, but "{obj.name}" has a read source '
                        "carrying @sql — the synthesized derivation and the "
                        "author's verbatim SQL are two sources of truth for the "
                        "same body",
                        ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY,
                        envelope=child.source,
                    )
                )
            else:
                msg = (
                    f'field "{obj.name}.{child.name}" carries an origin.* '
                    f'(derived) child, but "{obj.name}" has a source marked '
                    "@unmanaged — the tool never touches this object's DDL, so "
                    "the derivation is documented lineage only (not acted on); "
                    "this is informational, not an error"
                )
                if envelope_warnings is not None:
                    envelope_warnings.append(
                        LoaderWarning(
                            code=WARN_ORIGIN_UNDER_UNMANAGED,
                            message=msg,
                            source=child.source,
                        )
                    )
                if legacy_warnings is not None:
                    legacy_warnings.append(WARN_ORIGIN_UNDER_UNMANAGED)

        # R5 — a projection's row-scope @filter (#207) lowers to the outer
        # WHERE of a TOOL-SYNTHESIZED body; with @sql the author owns the
        # body (and its WHERE), so wrapping it is deferred cleverness
        # (design doc D5) — reject.
        if has_sql_host and obj.sub_type == OBJECT_SUBTYPE_PROJECTION:
            # ADR-0039: own — the @filter is declared locally on this
            # projection (mirrors _validate_projection_filter).
            filter_value = obj.attr(OBJECT_PROJECTION_ATTR_FILTER)
            if filter_value is not None:
                errors.append(
                    MetaError(
                        f'projection "{obj.name}" declares both @filter and an '
                        "@sql read source — a view-level @filter lowers to the "
                        "outer WHERE of a synthesized body; with @sql the author "
                        "owns the body (and its WHERE), so the two cannot be "
                        "combined",
                        ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY,
                        envelope=obj.source,
                    )
                )
