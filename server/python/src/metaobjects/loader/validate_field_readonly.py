"""FR-013 — field-level ``@readOnly`` cross-attribute rules.

Codes:
    * ``ERR_READONLY_ASSIGNED_PRIMARY`` — ``@readOnly: true`` on a field that is
      the target of an ``identity.primary`` with ``@generation: "assigned"``.
      The application has no path to populate the identity value.
    * ``ERR_READONLY_DOWNGRADE`` — a concrete subtype declares ``@readOnly:
      false`` on a field whose extends-chain parent declares ``@readOnly: true``.
      Read-only-ness can only be upgraded, never downgraded.
    * ``WARN_READONLY_VALUE_OBJECT`` — ``@readOnly: true`` on a field child of an
      ``object.value``. No persistence semantics apply; advisory only.

Mirrors the TS reference
``packages/metadata/src/core/field/validate-field-readonly.ts``.
"""
from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..meta.core.field.field_constants import FIELD_ATTR_READ_ONLY
from ..meta.core.identity.identity_constants import (
    GENERATION_ASSIGNED,
    IDENTITY_ATTR_FIELDS,
    IDENTITY_ATTR_GENERATION,
    IDENTITY_SUBTYPE_PRIMARY,
)
from ..meta.core.object.object_constants import OBJECT_SUBTYPE_VALUE
from ..shared.base_types import TYPE_FIELD, TYPE_IDENTITY, TYPE_OBJECT
from ..source.error_source import LoaderWarning

WARN_READONLY_VALUE_OBJECT = "WARN_READONLY_VALUE_OBJECT"


def _read_only_flag(field: MetaData) -> bool | None:
    """The explicit ``@readOnly`` value (True/False) or None when absent.

    ADR-0039 sanctioned own: the FR-013 downgrade rule needs THIS field's OWN
    explicit flag to distinguish an own-declared ``false`` from an inherited value
    — mirrors the TS ``readOnlyFlag`` (``field.ownAttr``)."""
    v = field.attr(FIELD_ATTR_READ_ONLY)
    return v if isinstance(v, bool) else None


def _inherited_field(obj: MetaData, name: str) -> MetaData | None:
    """Walk the extends chain for a field with ``name``; return its declaring
    node (own attrs intact) if found.

    ADR-0039 sanctioned own: explicit super-resolution walk (own children per
    ancestor while climbing the chain)."""
    cursor = obj.super_data
    while cursor is not None:
        for c in cursor.own_children():
            if c.type == TYPE_FIELD and c.name == name:
                return c
        cursor = cursor.super_data
    return None


def _primary_assigned_field_names(obj: MetaData) -> set[str]:
    """Names of fields participating in any ``identity.primary`` with
    ``@generation: "assigned"`` on ``obj`` or its extends chain (effective)."""
    out: set[str] = set()
    for ident in obj.children():
        if ident.type != TYPE_IDENTITY:
            continue
        if ident.sub_type != IDENTITY_SUBTYPE_PRIMARY:
            continue
        # ADR-0039 sanctioned own: validation reads the identity's OWN @generation/
        # @fields declaration (mirrors the TS validate-field-readonly ``id.ownAttr``);
        # the identity node itself is located via the resolving obj.children() above.
        if ident.attr(IDENTITY_ATTR_GENERATION) != GENERATION_ASSIGNED:
            continue
        fields = ident.attr(IDENTITY_ATTR_FIELDS)
        if isinstance(fields, (list, tuple)):
            for f_name in fields:
                if isinstance(f_name, str):
                    out.add(f_name)
        elif isinstance(fields, str):
            out.add(fields)
    return out


def validate_field_readonly(
    root: MetaData,
    errors: list[MetaError],
    envelope_warnings: list[LoaderWarning] | None = None,
    legacy_warnings: list[str] | None = None,
) -> None:
    # ADR-0039 sanctioned own: top-level object scan on the loader ROOT (never
    # extended, own == effective).
    for obj in root.own_children():
        if obj.type != TYPE_OBJECT:
            continue
        is_value_object = obj.sub_type == OBJECT_SUBTYPE_VALUE

        # 1) WARN_READONLY_VALUE_OBJECT — any @readOnly field child of object.value.
        if is_value_object:
            # ADR-0039 sanctioned own: validates what THIS object.value declares.
            for child in obj.own_children():
                if child.type == TYPE_FIELD and _read_only_flag(child) is True:
                    msg = (
                        f'field "{child.name}" on object.value "{obj.name}" '
                        "declares @readOnly: true; value-objects have no "
                        "persistence semantics so the read-only contract is "
                        "advisory (codegen may use it for record/struct treatment)."
                    )
                    if envelope_warnings is not None:
                        envelope_warnings.append(
                            LoaderWarning(
                                code=WARN_READONLY_VALUE_OBJECT,
                                message=msg,
                                source=child.source,
                            )
                        )
                    if legacy_warnings is not None:
                        legacy_warnings.append(WARN_READONLY_VALUE_OBJECT)

        # 2) ERR_READONLY_DOWNGRADE — read-only-ness can only be upgraded across
        #    extends. Only the explicit own @readOnly: false case matters.
        # ADR-0039 sanctioned own: the downgrade rule inspects only the fields THIS
        # object own-declares (own @readOnly:false vs the inherited parent's true).
        for own_field in obj.own_children():
            if own_field.type != TYPE_FIELD:
                continue
            if _read_only_flag(own_field) is not False:
                continue
            inherited = _inherited_field(obj, own_field.name)
            if inherited is not None and _read_only_flag(inherited) is True:
                errors.append(
                    MetaError(
                        f'field "{own_field.name}" on "{obj.name}" sets @readOnly: '
                        "false, but the extends-chain parent declares @readOnly: "
                        "true. Read-only-ness can only be upgraded, not downgraded "
                        "(FR-013).",
                        ErrorCode.ERR_READONLY_DOWNGRADE,
                        envelope=own_field.source,
                    )
                )

        # 3) ERR_READONLY_ASSIGNED_PRIMARY — @readOnly: true on a field used in an
        #    identity.primary whose @generation is "assigned" (effective tree).
        if not is_value_object:
            assigned = _primary_assigned_field_names(obj)
            if assigned:
                for field in obj.children():
                    if field.type != TYPE_FIELD:
                        continue
                    if field.name not in assigned:
                        continue
                    if _read_only_flag(field) is not True:
                        continue
                    errors.append(
                        MetaError(
                            f'field "{field.name}" on "{obj.name}" is @readOnly: '
                            "true AND the target of identity.primary with "
                            '@generation: "assigned"; the application has no path '
                            "to populate the identity value (FR-013).",
                            ErrorCode.ERR_READONLY_ASSIGNED_PRIMARY,
                            envelope=field.source,
                        )
                    )
