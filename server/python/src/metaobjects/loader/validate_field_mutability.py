"""FR-037 R1 — field-level ``@mutability`` cross-attribute rules.

``@mutability`` is ONE axis — who may write this field, and when — with three
mutually exclusive modes, ``readWrite`` (default) < ``writeOnce`` < ``readOnly``.
Modelling it as one enum rather than two booleans is what makes the illegal pair
unrepresentable and gives inheritance a total order.

Codes:
    * ``ERR_MUTABILITY_AUTOSET_CONFLICT`` — ``@autoSet`` on a field whose
      ``@mutability`` is ``writeOnce`` or ``readOnly``. ``@autoSet`` already says
      the SERVER supplies the value; that is a different axis from who may write
      it. The boolean era left readOnly x ``@autoSet`` representable but
      UNVALIDATED — the enum cut closes both arms with one rule.
    * ``ERR_MUTABILITY_DOWNGRADE`` — a subtype LOOSENS an inherited mode.
      Replaces ``ERR_READONLY_DOWNGRADE``: the rule now spans three modes, so a
      code named READONLY would misdescribe a ``writeOnce`` -> ``readWrite``
      loosening.
    * ``ERR_READONLY_ASSIGNED_PRIMARY`` — KEEPS ITS NAME: the condition is
      genuinely readOnly-specific. Note the asymmetry that justifies the enum —
      ``writeOnce`` on an assigned primary key is LEGAL, and indeed the natural
      declaration for one.
    * ``WARN_MUTABILITY_VALUE_OBJECT`` — a non-default mode on a field child of
      an ``object.value``. No persistence semantics apply; advisory only.
    * ``WARN_MUTABILITY_READONLY_HOST`` — ``writeOnce`` on a host nothing writes
      (a projection, or a read-only source ``@kind``). Benign: inert, not wrong.

Mirrors the TS reference
``packages/metadata/src/core/field/validate-field-mutability.ts``.
"""
from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..meta.core.field.field_constants import (
    FIELD_ATTR_AUTO_SET,
    FIELD_ATTR_MUTABILITY,
    MUTABILITY_MODES,
    MUTABILITY_READ_ONLY,
    MUTABILITY_READ_WRITE,
    MUTABILITY_WRITE_ONCE,
)
from ..meta.core.identity.identity_constants import (
    GENERATION_ASSIGNED,
    IDENTITY_ATTR_FIELDS,
    IDENTITY_ATTR_GENERATION,
    IDENTITY_SUBTYPE_PRIMARY,
)
from ..meta.core.object.object_constants import (
    OBJECT_SUBTYPE_PROJECTION,
    OBJECT_SUBTYPE_VALUE,
)
from ..shared.base_types import TYPE_FIELD, TYPE_IDENTITY, TYPE_OBJECT, TYPE_SOURCE
from ..source.error_source import LoaderWarning

WARN_MUTABILITY_VALUE_OBJECT = "WARN_MUTABILITY_VALUE_OBJECT"
WARN_MUTABILITY_READONLY_HOST = "WARN_MUTABILITY_READONLY_HOST"


def field_mutability(field: MetaData) -> str:
    """A field's EFFECTIVE mutability mode. Absent => ``readWrite``.

    THE accessor every consumer should use, so the default lives in exactly one
    place per port.

    ADR-0039: RESOLVING. Note the Python naming inversion — ``get_meta_attr()``
    resolves, ``attr()`` is own-only. Reading this with ``attr()`` would report
    ``readWrite`` for a field whose abstract parent declared ``readOnly``, and
    codegen would emit a setter for a column nothing may write.
    """
    v = field.get_meta_attr(FIELD_ATTR_MUTABILITY)
    return v if isinstance(v, str) and v in MUTABILITY_MODES else MUTABILITY_READ_WRITE


def is_read_only_mutability(field: MetaData) -> bool:
    """True when nothing may write this field."""
    return field_mutability(field) == MUTABILITY_READ_ONLY


def is_write_once_mutability(field: MetaData) -> bool:
    """True when the field is settable on create but frozen thereafter."""
    return field_mutability(field) == MUTABILITY_WRITE_ONCE


def _declared_mode(field: MetaData) -> str | None:
    """The mode THIS node declared, or None when it declared none.

    ADR-0039 sanctioned own: the downgrade rule needs the EXPLICIT mode on the
    DECLARING node — resolving would report a child's own value back at itself,
    and would warn on a value object that merely INHERITED the mode. In Python
    ``attr()`` IS the own-only accessor.
    """
    v = field.attr(FIELD_ATTR_MUTABILITY)
    return v if isinstance(v, str) and v in MUTABILITY_MODES else None


def _rank(mode: str) -> int:
    """Rank on the tightening order. Declaration order IS the order, so
    "may only tighten" is an index comparison rather than a lookup table."""
    return MUTABILITY_MODES.index(mode)


def _write_host_is_read_only(obj: MetaData) -> bool:
    """True when no write path reaches this object: an ``object.projection``, or
    an object whose every source is a read-only ``@kind``."""
    if obj.sub_type == OBJECT_SUBTYPE_PROJECTION:
        return True
    # ADR-0039: resolving — a source may be inherited via extends.
    sources = [c for c in obj.children() if c.type == TYPE_SOURCE]
    if not sources:
        return False
    return all(getattr(src, "is_read_only", lambda: False)() for src in sources)


def _inherited_field(obj: MetaData, name: str) -> MetaData | None:
    """Walk the extends chain for a field with ``name``; return its declaring
    node (own attrs intact) if found.

    ADR-0039 sanctioned own: explicit super-resolution walk (own children per
    ancestor while climbing the chain) — the comparison needs the DECLARING
    node's own mode."""
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
        # ADR-0039: resolving — an identity may inherit @generation / @fields via extends.
        if ident.get_meta_attr(IDENTITY_ATTR_GENERATION) != GENERATION_ASSIGNED:
            continue
        fields = ident.get_meta_attr(IDENTITY_ATTR_FIELDS)
        if isinstance(fields, (list, tuple)):
            for f_name in fields:
                if isinstance(f_name, str):
                    out.add(f_name)
        elif isinstance(fields, str):
            out.add(fields)
    return out


def _warn(
    code: str,
    message: str,
    source: object,
    envelope_warnings: list[LoaderWarning] | None,
    legacy_warnings: list[str] | None,
) -> None:
    if envelope_warnings is not None:
        envelope_warnings.append(LoaderWarning(code=code, message=message, source=source))
    if legacy_warnings is not None:
        legacy_warnings.append(code)


def validate_field_mutability(
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
        host_never_written = _write_host_is_read_only(obj)

        # ADR-0039 sanctioned own: rules 1 + 2 are own-vs-super comparisons by design.
        for own_field in obj.own_children():
            if own_field.type != TYPE_FIELD:
                continue
            own_mode = _declared_mode(own_field)

            # 1) WARN_MUTABILITY_VALUE_OBJECT — a non-default mode DECLARED on a
            #    value's own field. Advisory: a value has no persistence semantics.
            if is_value_object and own_mode is not None and own_mode != MUTABILITY_READ_WRITE:
                _warn(
                    WARN_MUTABILITY_VALUE_OBJECT,
                    f'field "{own_field.name}" on object.value "{obj.name}" declares '
                    f'@mutability: "{own_mode}"; value objects have no persistence '
                    "semantics, so the write contract is advisory (codegen may use it "
                    "for record/struct treatment).",
                    own_field.source,
                    envelope_warnings,
                    legacy_warnings,
                )

            # 2) ERR_MUTABILITY_DOWNGRADE — a subtype may TIGHTEN an inherited mode,
            #    never loosen it. Rank comparison over the declaration order.
            if own_mode is not None:
                inherited = _inherited_field(obj, own_field.name)
                inherited_mode = _declared_mode(inherited) if inherited is not None else None
                if inherited_mode is not None and _rank(own_mode) < _rank(inherited_mode):
                    errors.append(
                        MetaError(
                            f'field "{own_field.name}" on "{obj.name}" sets @mutability: '
                            f'"{own_mode}", but its extends-chain parent declares '
                            f'"{inherited_mode}". A subtype may only TIGHTEN an inherited '
                            f'mode ({" < ".join(MUTABILITY_MODES)}), never loosen it '
                            "(FR-037 R1).",
                            ErrorCode.ERR_MUTABILITY_DOWNGRADE,
                            envelope=own_field.source,
                        )
                    )

        # Rules 3 + 5 read the EFFECTIVE tree — an inherited mode is just as binding
        # as a declared one for "is this combination coherent?".
        for field in obj.children():
            if field.type != TYPE_FIELD:
                continue
            mode = field_mutability(field)

            # 3) ERR_MUTABILITY_AUTOSET_CONFLICT — @autoSet with a non-readWrite mode.
            if mode != MUTABILITY_READ_WRITE and field.get_meta_attr(FIELD_ATTR_AUTO_SET) is not None:
                errors.append(
                    MetaError(
                        f'field "{field.name}" on "{obj.name}" declares @autoSet together '
                        f'with @mutability: "{mode}". @autoSet already means the SERVER '
                        "supplies the value; @mutability says who may write it. Drop "
                        "@mutability (an @autoSet field is already excluded from every "
                        "input shape) or drop @autoSet (FR-037 R1).",
                        ErrorCode.ERR_MUTABILITY_AUTOSET_CONFLICT,
                        envelope=field.source,
                    )
                )

            # 5) WARN_MUTABILITY_READONLY_HOST — writeOnce on a host nothing writes.
            if mode == MUTABILITY_WRITE_ONCE and host_never_written:
                _warn(
                    WARN_MUTABILITY_READONLY_HOST,
                    f'field "{field.name}" on "{obj.name}" declares @mutability: '
                    '"writeOnce", but its host is never written (a projection, or a '
                    "read-only source @kind). The declaration is inert — nothing creates "
                    "a row here for it to be settable on.",
                    field.source,
                    envelope_warnings,
                    legacy_warnings,
                )

        # 4) ERR_READONLY_ASSIGNED_PRIMARY — readOnly on an ASSIGNED primary key.
        #    Note what is NOT here: writeOnce on an assigned key is legal, and is the
        #    natural declaration for one. That asymmetry is why this code keeps its
        #    readOnly-specific name.
        if not is_value_object:
            assigned = _primary_assigned_field_names(obj)
            if assigned:
                for field in obj.children():
                    if field.type != TYPE_FIELD:
                        continue
                    if field.name not in assigned:
                        continue
                    if not is_read_only_mutability(field):
                        continue
                    errors.append(
                        MetaError(
                            f'field "{field.name}" on "{obj.name}" is @mutability: '
                            '"readOnly" AND the target of identity.primary with '
                            '@generation: "assigned"; the application has no path to '
                            'populate the identity value. Use @mutability: "writeOnce" '
                            'if the intent is "set once on create, never changed" '
                            "(FR-037 R1).",
                            ErrorCode.ERR_READONLY_ASSIGNED_PRIMARY,
                            envelope=field.source,
                        )
                    )
