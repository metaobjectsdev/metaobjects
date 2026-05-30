"""Loader validation passes — run after super-resolution, before freeze (ADR-0002).

Errors are cross-node checks that cannot live on a single node. Each pass
appends to `errors` (list[MetaError]) or `warnings` (list[str]).
Error message text is free; error CODES are the conformance contract.
Warning strings are byte-identical to the expected-warnings fixtures.
"""
from __future__ import annotations

import re

from ..errors import ErrorCode, MetaError
from ..meta.core.field.field_constants import (
    ENUM_MEMBER_PATTERN,
    FIELD_ATTR_COERCE_DEFAULT,
    FIELD_ATTR_DEFAULT,
    FIELD_ATTR_OBJECT_REF,
    FIELD_ATTR_STORAGE,
    FIELD_ATTR_VALUES,
    FIELD_SUBTYPE_ENUM,
    FIELD_SUBTYPE_OBJECT,
    FIELD_SUBTYPE_STRING,
    FIELD_SUBTYPE_TIMESTAMP,
)
from ..meta.persistence.db.db_constants import (
    DB_COLUMN_TYPE_JSONB,
    DB_COLUMN_TYPE_TIMESTAMP_TZ,
    DB_COLUMN_TYPE_UUID,
    FIELD_ATTR_DB_COLUMN_TYPE,
    VALID_DB_COLUMN_TYPES,
)
from ..meta.core.object.meta_object import MetaObject
from ..meta.meta_data import MetaData
from ..meta.persistence.source.meta_source import MetaSource
from ..meta.persistence.source.source_constants import SOURCE_ROLE_PRIMARY
from ..registry import AttrSchema, TypeRegistry
from ..shared.base_types import (
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_LAYOUT,
    TYPE_OBJECT,
    TYPE_ORIGIN,
    TYPE_RELATIONSHIP,
    TYPE_SOURCE,
    TYPE_TEMPLATE,
)
from ..meta.template import template_constants as tc
from ..meta.presentation.layout.layout_constants import (
    LAYOUT_ATTR_DEFAULT_SORT_FIELD,
    LAYOUT_ATTR_FILTER,
    LAYOUT_SUBTYPE_DATA_GRID,
)
from ..meta.persistence.origin.origin_constants import (
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_OF,
    ORIGIN_ATTR_VIA,
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_PASSTHROUGH,
)
from ..meta.core.relationship.relationship_constants import RELATIONSHIP_ATTR_OBJECT_REF
from ..meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_VALUE
from ..meta.core.identity.identity_constants import IDENTITY_ATTR_FIELDS
from ..source import resolved_source

# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_validations(
    root: MetaData,
    registry: TypeRegistry,
    errors: list[MetaError],
    warnings: list[str],
) -> None:
    """Run all validation passes in order.

    Passes are designed to be additive: later tasks add passes here.
    """
    _validate_attr_schema(root, registry, errors)
    _validate_enum_values(root, errors)
    _validate_db_column_type(root, errors)
    _validate_datagrid_sort_fields(root, errors)
    _validate_datagrid_filter_values(root, errors)
    _validate_origin_paths(root, errors)
    _validate_one_primary_source(root, errors)
    _validate_field_object_storage(root, errors)
    _validate_templates(root, errors)
    _validate_subtype_rules(root, errors, warnings)
    _validate_filterable_has_index(root, warnings)


# ---------------------------------------------------------------------------
# Walk helper
# ---------------------------------------------------------------------------


def _walk(root: MetaData) -> list[MetaData]:
    """Return all authored nodes in the tree (BFS order, including root)."""
    result: list[MetaData] = []
    queue: list[MetaData] = [root]
    while queue:
        node = queue.pop(0)
        result.append(node)
        queue.extend(node.own_children())
    return result


# ---------------------------------------------------------------------------
# Pass: attr-schema validation
# ---------------------------------------------------------------------------
# Three checks per node:
#   1. Required attrs present (checks effective attr set — inherited attrs satisfy
#      the requirement, mirroring the TS reference in attr-schema-validate.ts).
#   2. Type check: for each OWN attr whose name matches a schema, validate the
#      stored (post-desugar) value type against schema.value_type.
#   3. Allowed-values check: for own attrs with a matching schema that declares
#      allowed_values, the value must be a member.


def _type_ok(value: object, value_type: str) -> bool:
    """Return True if *value* matches *value_type* (an attr subtype name)."""
    if value_type == "int":
        return isinstance(value, int) and not isinstance(value, bool)
    if value_type == "long":
        return isinstance(value, int) and not isinstance(value, bool)
    if value_type == "double":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if value_type == "boolean":
        return isinstance(value, bool)
    if value_type == "string":
        return isinstance(value, str)
    if value_type == "stringArray":
        return isinstance(value, list)
    if value_type in ("filter", "properties"):
        # Object-typed attrs must be a dict (not a string, not an array).
        # A legacy-string @filter (not desugared to a dict) is invalid:
        # FilterAttr.desugar only applies when the input IS a dict; if a string
        # was passed it remains a str. Mirrors C# ValueMatchesType (properties
        # + filter both require IReadOnlyDictionary) — feeds the FR-010
        # @enumAlias/@enumDoc shape guard.
        return isinstance(value, dict)
    # Unknown value types (e.g. "class") — allow anything.
    return True


def _node_label(node: MetaData) -> str:
    head = f"{node.type}.{node.sub_type}"
    return f"{head} '{node.name}'" if node.name else head


def _effective_schemas(
    type_: str,
    sub_type: str,
    common_attrs: list[AttrSchema],
    registry: TypeRegistry,
    errors: list[MetaError],
    node: MetaData,
) -> tuple[list[AttrSchema], dict[str, AttrSchema]]:
    """Compute the effective attr schema for a (type, sub_type).

    Per-type attrs win over common attrs of the same name. If any collision
    exists, append a single ERR_PROVIDER_ATTR_CONFLICT for this (type, sub_type).
    *node* supplies the FR5a envelope for the conflict error (matches C#
    ValidationPasses.cs:593-596 — ``Envelope: node.Source``).
    """
    per_type_attrs = registry.attrs_of(type_, sub_type)
    per_type_names = {s.name for s in per_type_attrs}

    for ca in common_attrs:
        if ca.name in per_type_names:
            errors.append(
                MetaError(
                    f"{type_}.{sub_type} has a per-type attr '@{ca.name}' "
                    f"that conflicts with a common attr of the same name",
                    ErrorCode.ERR_PROVIDER_ATTR_CONFLICT,
                    envelope=node.source,
                )
            )
            break  # one error per (type, sub_type) is sufficient

    schemas = per_type_attrs + [ca for ca in common_attrs if ca.name not in per_type_names]
    return schemas, {s.name: s for s in schemas}


def _validate_attr_schema(
    root: MetaData,
    registry: TypeRegistry,
    errors: list[MetaError],
) -> None:
    common_attrs = registry.get_common_attrs()
    # Cache effective schemas per (type, sub_type) — also dedupes the per-type-vs-common
    # conflict report (the registry is global, so each (type, sub_type) yields one error).
    schema_cache: dict[tuple[str, str], tuple[list[AttrSchema], dict[str, AttrSchema]]] = {}

    for node in _walk(root):
        key = (node.type, node.sub_type)
        cached = schema_cache.get(key)
        if cached is None:
            cached = _effective_schemas(node.type, node.sub_type, common_attrs, registry, errors, node)
            schema_cache[key] = cached
        schemas, schema_by_name = cached

        if not schemas:
            continue

        # --- Check 1: required attrs must be present (uses node.attrs() = effective,
        #     so an inherited attr from the super chain satisfies the requirement) ---
        present_attrs = node.attrs()
        for schema in schemas:
            if not schema.required:
                continue
            if schema.name not in present_attrs:
                errors.append(
                    MetaError(
                        f"{_node_label(node)} is missing required attribute '@{schema.name}'",
                        ErrorCode.ERR_MISSING_REQUIRED_ATTR,
                        envelope=node.source,
                    )
                )

        # --- Checks 2 + 3: own attrs only (inherited attrs were already checked on
        #     the node that declared them; re-checking would double-report) ---
        for attr_node in node.own_meta_attrs():
            maybe_schema: AttrSchema | None = schema_by_name.get(attr_node.name)
            if maybe_schema is None:
                continue  # undeclared attr — open policy: ignore
            schema = maybe_schema

            raw_value = getattr(attr_node, "value", None)
            if raw_value is None:
                continue

            # Check 2: type validation
            if schema.value_type is not None:
                if not _type_ok(raw_value, schema.value_type):
                    errors.append(
                        MetaError(
                            f"{_node_label(node)} attribute '@{attr_node.name}' has value "
                            f"{raw_value!r} which does not match expected type '{schema.value_type}'",
                            ErrorCode.ERR_BAD_ATTR_VALUE,
                            envelope=node.source,
                        )
                    )
                    continue  # type wrong — skip allowed_values check

            # Check 3: allowed_values membership
            if schema.allowed_values is not None and len(schema.allowed_values) > 0:
                if raw_value not in schema.allowed_values:
                    allowed_str = ", ".join(str(v) for v in schema.allowed_values)
                    errors.append(
                        MetaError(
                            f"{_node_label(node)} attribute '@{attr_node.name}' has value "
                            f"'{raw_value}' which is not one of the allowed values: {allowed_str}",
                            ErrorCode.ERR_BAD_ATTR_VALUE,
                            envelope=node.source,
                        )
                    )


# ---------------------------------------------------------------------------
# Pass: field.enum @values content validation (cross-language contract)
# ---------------------------------------------------------------------------
# Checks OWN @values only — inherited members were already validated on the node
# that declared them (own-only rule, mirrors TS/C#/Java behaviour).
#
# Three content rules, all → ERR_BAD_ATTR_VALUE:
#   1. Non-empty: @values must contain at least one member.
#   2. Identifier-safe: every member must match ENUM_MEMBER_PATTERN.
#   3. No duplicates.

_ENUM_MEMBER_RE = re.compile(ENUM_MEMBER_PATTERN)


def _validate_enum_values(
    root: MetaData,
    errors: list[MetaError],
) -> None:
    for node in _walk(root):
        if node.type != TYPE_FIELD or node.sub_type != FIELD_SUBTYPE_ENUM:
            continue

        # FR-011 own-attr checks apply to every enum node (a concrete enum can own
        # @coerceDefault / @default / @normalize while inheriting @values).
        _validate_enum_fr011_attrs(node, errors)

        # Own-only: node.attr() reads only this node's own attrs (never the super
        # chain), so an inherited @values yields None here and is skipped.
        own_values = node.attr(FIELD_ATTR_VALUES)
        if own_values is None:
            # No own @values — required-attr check (ERR_MISSING_REQUIRED_ATTR) is
            # handled by _validate_attr_schema.  Nothing more to do here.
            continue

        if not isinstance(own_values, list):
            # Type mismatch — already reported by _validate_attr_schema.
            continue

        label = _node_label(node)

        # Rule 1: non-empty
        if len(own_values) == 0:
            errors.append(
                MetaError(
                    f"{label} attribute '@{FIELD_ATTR_VALUES}' must not be empty",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    envelope=node.source,
                )
            )
            continue  # further checks don't apply to empty list

        # Rule 2: identifier-safe members
        for member in own_values:
            if not isinstance(member, str) or not _ENUM_MEMBER_RE.match(member):
                errors.append(
                    MetaError(
                        f"{label} attribute '@{FIELD_ATTR_VALUES}' member {member!r} "
                        f"is not a valid identifier (must match {ENUM_MEMBER_PATTERN})",
                        ErrorCode.ERR_BAD_ATTR_VALUE,
                        envelope=node.source,
                    )
                )
                break  # one error per field is sufficient

        # Rule 3: no duplicates
        if len(own_values) != len(set(own_values)):
            errors.append(
                MetaError(
                    f"{label} attribute '@{FIELD_ATTR_VALUES}' contains duplicate members",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    envelope=node.source,
                )
            )


def _effective_enum_values(node: MetaData) -> list[str]:
    """The effective ``@values`` members of an enum node (own or inherited via
    ``extends:``). Empty list when absent. Mirrors Java ``effectiveEnumValues``."""
    v = node.attrs().get(FIELD_ATTR_VALUES)
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if x is not None]
    if isinstance(v, str):
        return [t for t in (s.strip() for s in v.split(",")) if t]
    return []


def _validate_enum_fr011_attrs(node: MetaData, errors: list[MetaError]) -> None:
    """FR-011 own-attr validation for a ``field.enum`` node.

    * ``@coerceDefault`` (own) must be a member of the EFFECTIVE ``@values``
      (own or inherited) → ``ERR_BAD_ATTR_VALUE``.
    * ``@default`` (own, the absent-fill member) must likewise be a member of the
      effective ``@values`` → ``ERR_BAD_ATTR_VALUE``.
    ``@normalize`` mode validation is NOT done here: it is a closed enum gated by the
    registered ``allowed_values=NORMALIZE_MODES`` on the ``field.enum`` attr schema, so the
    generic attr-schema pass already emits the single ``ERR_BAD_ATTR_VALUE``. Re-checking it
    here double-reported the same node (one envelope entry per port is the cross-port contract).

    Own-only policy: only checks attrs declared on THIS node, matching the ``@values``
    pass. The membership set is read effectively so an enum that owns ``@coerceDefault``
    / ``@default`` while inheriting ``@values`` still validates correctly.
    """
    label = _node_label(node)
    members: list[str] | None = None  # lazily computed (only when a member attr is owned)

    for attr_name in (FIELD_ATTR_COERCE_DEFAULT, FIELD_ATTR_DEFAULT):
        own = node.attr(attr_name)
        if not isinstance(own, str):
            continue
        if members is None:
            members = _effective_enum_values(node)
        if own not in members:
            errors.append(
                MetaError(
                    f"{label} attribute '@{attr_name}' value {own!r} "
                    f"is not one of '@{FIELD_ATTR_VALUES}': {', '.join(members)}",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    envelope=node.source,
                )
            )


# ---------------------------------------------------------------------------
# Pass: @dbColumnType physical column-type validation (R6 Plan 2b, ADR-0013)
# ---------------------------------------------------------------------------
# Own-only validation of the @dbColumnType physical column-type attribute,
# mirroring the field.enum @values precedent. Two rules, both → ERR_BAD_ATTR_VALUE:
#
#   1. The value must be one of the closed set uuid|jsonb|timestamp_with_tz.
#      (@dbColumnType is registered as a bare string attr — no allowed_values — so
#      this pass is the SOLE enforcer of the closed set: an unknown value fires
#      exactly one ERR_BAD_ATTR_VALUE, matching TS/Java/C#.)
#   2. The (logical subtype × value) pairing must be legal:
#        uuid              → field.string
#        jsonb             → field.string
#        timestamp_with_tz → field.timestamp
#
# Own-only: only @dbColumnType declared on THIS node is validated (a physical
# attr is never inherited via extends:). Cross-port: TS/C#/Java run the identical
# own-only check.

# value → the field subtype it is legal on.
_DB_COLUMN_TYPE_REQUIRED_SUBTYPE: dict[str, str] = {
    DB_COLUMN_TYPE_UUID: FIELD_SUBTYPE_STRING,
    DB_COLUMN_TYPE_JSONB: FIELD_SUBTYPE_STRING,
    DB_COLUMN_TYPE_TIMESTAMP_TZ: FIELD_SUBTYPE_TIMESTAMP,
}


def _validate_db_column_type(root: MetaData, errors: list[MetaError]) -> None:
    for node in _walk(root):
        if node.type != TYPE_FIELD:
            continue
        # Own-only: node.attr() reads only this node's own attrs (never the super
        # chain), so an inherited @dbColumnType yields None here and is skipped.
        value = node.attr(FIELD_ATTR_DB_COLUMN_TYPE)
        if not isinstance(value, str):
            continue

        # Rule 1: recognized value.
        if value not in VALID_DB_COLUMN_TYPES:
            errors.append(
                MetaError(
                    f"field '{node.name}' attribute '@{FIELD_ATTR_DB_COLUMN_TYPE}' "
                    f"value {value!r} is not a valid value; allowed: "
                    f"{', '.join(VALID_DB_COLUMN_TYPES)}",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    envelope=node.source,
                )
            )
            continue

        # Rule 2: legal (subtype × value) pairing.
        required_subtype = _DB_COLUMN_TYPE_REQUIRED_SUBTYPE[value]
        if node.sub_type != required_subtype:
            # Derive the allowed-pairings list from the map so it stays the single
            # source of truth for pairing legality.
            pairings = ", ".join(
                f"{v}→field.{st}" for v, st in _DB_COLUMN_TYPE_REQUIRED_SUBTYPE.items()
            )
            errors.append(
                MetaError(
                    f"field '{node.name}' attribute '@{FIELD_ATTR_DB_COLUMN_TYPE}' "
                    f"value {value!r} is not valid on field.{node.sub_type} "
                    f"(requires field.{required_subtype}); allowed pairings: {pairings}",
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    envelope=node.source,
                )
            )


# ---------------------------------------------------------------------------
# Pass: dataGrid @defaultSortField validation
# ---------------------------------------------------------------------------
# For each object.* node, check each layout.dataGrid child: if @defaultSortField
# is set and not in the object's effective field names → ERR_BAD_DEFAULT_SORT_FIELD.


def _validate_datagrid_sort_fields(
    root: MetaData,
    errors: list[MetaError],
) -> None:
    for node in _walk(root):
        if node.type != TYPE_OBJECT:
            continue
        if not isinstance(node, MetaObject):
            continue

        field_names: set[str] = {f.name for f in node.fields()}

        for child in node.children():
            if child.type != TYPE_LAYOUT or child.sub_type != LAYOUT_SUBTYPE_DATA_GRID:
                continue
            sort_field = child.attr(LAYOUT_ATTR_DEFAULT_SORT_FIELD)
            if sort_field is None:
                continue
            if not isinstance(sort_field, str):
                continue
            if sort_field not in field_names:
                errors.append(
                    MetaError(
                        f"{_node_label(node)} layout.dataGrid '{child.name}' references "
                        f"@defaultSortField='{sort_field}' which is not a field on this object "
                        f"(known fields: {sorted(field_names)})",
                        ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD,
                        envelope=child.source,
                    )
                )


# ---------------------------------------------------------------------------
# Ops-per-field-subtype allow-table (from query-constants.ts)
# ---------------------------------------------------------------------------
# string         → eq, ne, in, like, isNull
# boolean        → eq, isNull
# numerics + temporal → eq, ne, gt, gte, lt, lte, in, isNull

_OPS_STRING: frozenset[str] = frozenset({"eq", "ne", "in", "like", "isNull"})
_OPS_BOOLEAN: frozenset[str] = frozenset({"eq", "isNull"})
_OPS_NUMERIC_TEMPORAL: frozenset[str] = frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"})

_NUMERIC_TEMPORAL_SUBTYPES: frozenset[str] = frozenset(
    {"int", "short", "byte", "long", "double", "float", "decimal", "date", "time", "timestamp"}
)


def ops_for_subtype(field_subtype: str) -> frozenset[str]:
    """Return the set of allowed filter operators for a given field subtype.

    Mirrors the ops-per-subtype allow-table from query-constants.ts.
    """
    if field_subtype == "string":
        return _OPS_STRING
    if field_subtype == "boolean":
        return _OPS_BOOLEAN
    if field_subtype in _NUMERIC_TEMPORAL_SUBTYPES:
        return _OPS_NUMERIC_TEMPORAL
    # Unknown/extension subtypes: closed allowlist — no operators permitted.
    return frozenset()


# ---------------------------------------------------------------------------
# Pass: dataGrid @filter field + op validation
# ---------------------------------------------------------------------------
# For each object.* node, build a filterable map from effective fields.
# For each layout.dataGrid child's @filter dict: check that each referenced
# field is filterable and that each operator is allowed for that field's subtype.


def _validate_datagrid_filter_values(
    root: MetaData,
    errors: list[MetaError],
) -> None:
    for node in _walk(root):
        if node.type != TYPE_OBJECT:
            continue
        if not isinstance(node, MetaObject):
            continue

        # Build filterable map: field_name → allowed ops set
        filterable: dict[str, frozenset[str]] = {
            f.name: ops_for_subtype(f.sub_type)
            for f in node.fields()
            if f.attr("filterable") is True
        }

        for child in node.children():
            if child.type != TYPE_LAYOUT or child.sub_type != LAYOUT_SUBTYPE_DATA_GRID:
                continue
            filter_value = child.attr(LAYOUT_ATTR_FILTER)
            if filter_value is None:
                continue
            if not isinstance(filter_value, dict):
                # Type check handled by attr-schema pass (ERR_BAD_ATTR_VALUE).
                continue

            for field_name, clause in filter_value.items():
                if field_name not in filterable:
                    errors.append(
                        MetaError(
                            f"{_node_label(node)} layout.dataGrid '{child.name}' @filter "
                            f"references field '{field_name}' which is not a filterable field "
                            f"on this object",
                            ErrorCode.ERR_BAD_ATTR_FILTER,
                            envelope=child.source,
                        )
                    )
                    continue

                allowed_ops = filterable[field_name]
                if not isinstance(clause, dict):
                    # Shorthand (scalar/list/null) desugared to op-object by FilterAttr;
                    # if still not a dict here, skip (attr-schema pass covers type errors).
                    continue
                for op in clause:
                    if op not in allowed_ops:
                        field_obj = node.find_field(field_name)
                        sub = field_obj.sub_type if field_obj is not None else "?"
                        errors.append(
                            MetaError(
                                f"{_node_label(node)} layout.dataGrid '{child.name}' @filter "
                                f"uses operator '{op}' on field '{field_name}' which is not "
                                f"allowed for field subtype '{sub}'",
                                ErrorCode.ERR_BAD_ATTR_FILTER,
                                envelope=child.source,
                            )
                        )


# ---------------------------------------------------------------------------
# Pass: origin @from / @of / @via path validation
# ---------------------------------------------------------------------------
# For each field node that has an origin.passthrough or origin.aggregate child,
# validate that the dotted references resolve against the known object index.
#
# @from (passthrough) / @of (aggregate): "Entity.fieldName"
#   - The entity must exist in the tree; the field must exist on that entity.
#
# @via (optional on passthrough, required on aggregate): "Entity.rel1[.rel2...]"
#   - Split on "."; first segment is the entity name (must exist in index).
#   - Each subsequent segment is a relationship name on the current entity;
#     the relationship's @objectRef names the next entity (must exist in index);
#     advance the current-entity pointer.
#   - Any missing entity/relationship → ERR_INVALID_ORIGIN.


def _build_object_index(root: MetaData) -> dict[str, MetaObject]:
    """Return a name → MetaObject index of all top-level objects in *root*."""
    index: dict[str, MetaObject] = {}
    for child in root.own_children():
        if child.type == TYPE_OBJECT and isinstance(child, MetaObject):
            if child.name:
                index[child.name] = child
    return index


def _relationships_by_name(obj: MetaObject) -> dict[str, MetaData]:
    """Return a name → node map of all relationship children on *obj* (effective)."""
    result: dict[str, MetaData] = {}
    for child in obj.children():
        if child.type == TYPE_RELATIONSHIP and child.name:
            result[child.name] = child
    return result


def _validate_entity_field_ref(
    ref: str,
    attr_name: str,
    context: str,
    object_index: dict[str, MetaObject],
    errors: list[MetaError],
    origin_node: MetaData,
    referrer: str,
) -> bool:
    """Validate a dotted 'Entity.fieldName' reference.

    Appends ERR_INVALID_ORIGIN to *errors* if invalid; returns True if valid.

    *attr_name* is used only for the error message text; *context* identifies the
    origin node for diagnostic purposes; *origin_node* carries the parse-time
    envelope (files/json_path); *referrer* is the canonical referrer FQN
    (``<projection-FQN>::<fieldName>``) attached to the FR5d ResolvedSource
    envelope so consumers know which node declared the broken reference.
    """
    parts = ref.split(".", 1)
    if len(parts) != 2:
        # Malformed shape — not a reference-resolution failure per se, but TS
        # emits format=resolved here too (with target=the bad string) so every
        # FR5d site is shape-consistent across the four ports.
        errors.append(
            MetaError(
                f"{context} @{attr_name}='{ref}' must be in 'EntityName.fieldName' format",
                ErrorCode.ERR_INVALID_ORIGIN,
                envelope=resolved_source(origin_node.source, referrer, ref),
            )
        )
        return False
    entity_name, field_name = parts
    entity = object_index.get(entity_name)
    if entity is None:
        # FR5d — entity half of the ref didn't resolve. target = full ref.
        errors.append(
            MetaError(
                f"{context} @{attr_name}='{ref}' references unknown entity '{entity_name}'",
                ErrorCode.ERR_INVALID_ORIGIN,
                envelope=resolved_source(origin_node.source, referrer, ref),
            )
        )
        return False
    field_names = {f.name for f in entity.fields()}
    if field_name not in field_names:
        # FR5d — entity resolved, field on it did not. target = full ref.
        errors.append(
            MetaError(
                f"{context} @{attr_name}='{ref}' references field '{field_name}' which does "
                f"not exist on entity '{entity_name}' (known fields: {sorted(field_names)})",
                ErrorCode.ERR_INVALID_ORIGIN,
                envelope=resolved_source(origin_node.source, referrer, ref),
            )
        )
        return False
    return True


def _validate_via_path(
    via: str,
    context: str,
    object_index: dict[str, MetaObject],
    errors: list[MetaError],
    origin_node: MetaData,
    referrer: str,
) -> bool:
    """Validate a dotted relationship path 'Entity.rel1[.rel2...]'.

    Returns True if valid; appends ERR_INVALID_ORIGIN and returns False if not.

    *origin_node* carries the parse-time envelope (files/json_path); *referrer*
    is the canonical referrer FQN (``<projection-FQN>::<fieldName>``) attached
    to the FR5d ResolvedSource envelope.

    Multi-hop walks track the deepest-valid-prefix and name it in the error
    message on a hop failure (mirrors TS reference at validation-passes.ts
    L304-L325).
    """
    segments = via.split(".")
    if len(segments) < 2:
        errors.append(
            MetaError(
                f"{context} @via='{via}' must be in 'EntityName.relName[.relName...]' format",
                ErrorCode.ERR_INVALID_ORIGIN,
                envelope=resolved_source(origin_node.source, referrer, via),
            )
        )
        return False

    # First segment: starting entity
    current_name = segments[0]
    current_entity = object_index.get(current_name)
    if current_entity is None:
        errors.append(
            MetaError(
                f"{context} @via='{via}' references unknown entity '{current_name}'",
                ErrorCode.ERR_INVALID_ORIGIN,
                envelope=resolved_source(origin_node.source, referrer, via),
            )
        )
        return False

    # FR5d — track the deepest-valid-prefix as we walk. The prefix starts at
    # the entity name (resolved above) and grows by one segment per successful
    # relationship hop. On hop failure the message names the prefix that DID
    # resolve so authors can fix multi-hop typos quickly.
    valid_segments: list[str] = [current_name]
    for rel_name in segments[1:]:
        rels = _relationships_by_name(current_entity)
        rel_node = rels.get(rel_name)
        if rel_node is None:
            prefix = ".".join(valid_segments)
            errors.append(
                MetaError(
                    f"{context} @via='{via}' — entity '{current_entity.name}' has no "
                    f"relationship '{rel_name}' (known relationships: {sorted(rels)}). "
                    f'Deepest valid prefix was "{prefix}".',
                    ErrorCode.ERR_INVALID_ORIGIN,
                    envelope=resolved_source(origin_node.source, referrer, via),
                )
            )
            return False

        # Advance to the referenced entity
        obj_ref = rel_node.attr(RELATIONSHIP_ATTR_OBJECT_REF)
        if not isinstance(obj_ref, str):
            errors.append(
                MetaError(
                    f"{context} @via='{via}' — relationship '{rel_name}' on entity "
                    f"'{current_entity.name}' has no @objectRef",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    envelope=resolved_source(origin_node.source, referrer, via),
                )
            )
            return False

        next_entity = object_index.get(obj_ref)
        if next_entity is None:
            # FR5d — relationship's @objectRef points at a missing entity.
            # target=the @objectRef value (mirrors TS validation-passes.ts L342-353).
            errors.append(
                MetaError(
                    f"{context} @via='{via}' — relationship '{rel_name}' on entity "
                    f"'{current_entity.name}' references unknown entity '{obj_ref}'",
                    ErrorCode.ERR_INVALID_ORIGIN,
                    envelope=resolved_source(origin_node.source, referrer, obj_ref),
                )
            )
            return False

        valid_segments.append(rel_name)
        current_entity = next_entity

    return True


def _validate_origin_paths(
    root: MetaData,
    errors: list[MetaError],
) -> None:
    """Validate @from/@of/@via dotted-path attrs on origin.passthrough and
    origin.aggregate nodes.

    Errors use ERR_INVALID_ORIGIN. Only validates; does NOT alter the tree.
    """
    object_index = _build_object_index(root)

    for node in _walk(root):
        if node.type != TYPE_FIELD:
            continue
        # The projection that owns this field. The field walks via _walk so the
        # field's parent is the containing object (.projection in source-v2).
        projection = node.parent if hasattr(node, "parent") else None
        for origin in node.children():
            if origin.type != TYPE_ORIGIN:
                continue
            ctx = f"field '{node.name}' origin.{origin.sub_type}"
            # FR5d — referrer is `<projection-FQN>::<fieldName>` (the canonical
            # "where the broken reference lives" identifier). When we cannot
            # find a projection (defensive), fall back to the field's own FQN.
            if projection is not None and hasattr(projection, "fqn"):
                referrer = f"{projection.fqn()}::{node.name}"
            else:
                referrer = node.fqn() if hasattr(node, "fqn") else node.name

            if origin.sub_type == ORIGIN_SUBTYPE_PASSTHROUGH:
                from_ref = origin.attr(ORIGIN_ATTR_FROM)
                if not isinstance(from_ref, str) or not from_ref:
                    # Missing-attr (not a reference resolution failure) — keep
                    # the origin node's own source envelope (json/yaml/merged).
                    # Mirrors TS validation-passes.ts L370-378.
                    errors.append(
                        MetaError(
                            f"{ctx} is missing required attribute '@{ORIGIN_ATTR_FROM}'",
                            ErrorCode.ERR_INVALID_ORIGIN,
                            envelope=origin.source,
                        )
                    )
                else:
                    _validate_entity_field_ref(
                        from_ref, ORIGIN_ATTR_FROM, ctx, object_index, errors, origin,
                        referrer,
                    )
                via = origin.attr(ORIGIN_ATTR_VIA)
                if isinstance(via, str) and via:
                    _validate_via_path(via, ctx, object_index, errors, origin, referrer)

            elif origin.sub_type == ORIGIN_SUBTYPE_AGGREGATE:
                of_ref = origin.attr(ORIGIN_ATTR_OF)
                if not isinstance(of_ref, str) or not of_ref:
                    errors.append(
                        MetaError(
                            f"{ctx} is missing required attribute '@{ORIGIN_ATTR_OF}'",
                            ErrorCode.ERR_INVALID_ORIGIN,
                            envelope=origin.source,
                        )
                    )
                else:
                    _validate_entity_field_ref(
                        of_ref, ORIGIN_ATTR_OF, ctx, object_index, errors, origin,
                        referrer,
                    )
                via = origin.attr(ORIGIN_ATTR_VIA)
                if not isinstance(via, str) or not via:
                    errors.append(
                        MetaError(
                            f"{ctx} is missing required attribute '@{ORIGIN_ATTR_VIA}'",
                            ErrorCode.ERR_INVALID_ORIGIN,
                            envelope=origin.source,
                        )
                    )
                else:
                    _validate_via_path(via, ctx, object_index, errors, origin, referrer)


# ---------------------------------------------------------------------------
# Pass: one-primary multi-source rule (ADR-0007 source v2)
# ---------------------------------------------------------------------------
# Walks every object.entity / object.value; counts source own-children with
# role == "primary" (using the default-aware MetaSource.role() getter):
#   - 0 sources total → skip (object is not persisted).
#   - exactly 1 primary → OK.
#   - 0 primaries → ERR_SOURCE_NO_PRIMARY.
#   - >1 primaries → ERR_SOURCE_MULTIPLE_PRIMARY.


def _validate_one_primary_source(
    root: MetaData,
    errors: list[MetaError],
) -> None:
    for node in _walk(root):
        if node.type != TYPE_OBJECT:
            continue
        if not isinstance(node, MetaObject):
            continue

        sources = [c for c in node.own_children() if c.type == TYPE_SOURCE]
        if not sources:
            continue

        primary_count = sum(
            1
            for s in sources
            if isinstance(s, MetaSource) and s.role() == SOURCE_ROLE_PRIMARY
        )

        if primary_count == 0:
            errors.append(
                MetaError(
                    f"{_node_label(node)} declares {len(sources)} source(s) but "
                    f"none has role '{SOURCE_ROLE_PRIMARY}'",
                    ErrorCode.ERR_SOURCE_NO_PRIMARY,
                    envelope=node.source,
                )
            )
        elif primary_count > 1:
            errors.append(
                MetaError(
                    f"{_node_label(node)} declares {primary_count} sources with "
                    f"role '{SOURCE_ROLE_PRIMARY}'; exactly one is required",
                    ErrorCode.ERR_SOURCE_MULTIPLE_PRIMARY,
                    envelope=node.source,
                )
            )


# ---------------------------------------------------------------------------
# Pass: subtype-rules
# ---------------------------------------------------------------------------
# object.entity with no effective primary identity and not abstract → warning.
# object.value with a primary identity → ERR_SUBTYPE_RULE_VIOLATION (error).


def _validate_subtype_rules(
    root: MetaData,
    errors: list[MetaError],
    warnings: list[str],
) -> None:
    for node in _walk(root):
        if node.type != TYPE_OBJECT:
            continue
        if not isinstance(node, MetaObject):
            continue

        if node.sub_type == OBJECT_SUBTYPE_ENTITY:
            # Concrete (non-abstract) entity with no primary identity → warning.
            if not node.is_abstract and node.primary_identity() is None:
                warnings.append(
                    f"entity object '{node.name}' has no primary identity "
                    f"(add an identity child or mark @isAbstract: true)"
                )

        elif node.sub_type == OBJECT_SUBTYPE_VALUE:
            # value object should NOT have a primary identity.
            if node.primary_identity() is not None:
                errors.append(
                    MetaError(
                        f"{_node_label(node)} is a value object but declares a primary identity",
                        ErrorCode.ERR_SUBTYPE_RULE_VIOLATION,
                        envelope=node.source,
                    )
                )


# ---------------------------------------------------------------------------
# Pass: filterable-without-index
# ---------------------------------------------------------------------------
# For each field with @filterable: true that is NOT part of any identity (@fields)
# on its owning object AND has no @db.indexed: true → warning.


def _identity_field_names(obj: MetaObject) -> set[str]:
    """Return the set of field names covered by ANY identity on *obj* (effective)."""
    covered: set[str] = set()
    for child in obj.children():
        if child.type != TYPE_IDENTITY:
            continue
        fields_val = child.attr(IDENTITY_ATTR_FIELDS)
        if isinstance(fields_val, list):
            covered.update(str(f) for f in fields_val)
        elif isinstance(fields_val, str):
            covered.add(fields_val)
    return covered


def _validate_filterable_has_index(
    root: MetaData,
    warnings: list[str],
) -> None:
    for node in _walk(root):
        if node.type != TYPE_OBJECT:
            continue
        if not isinstance(node, MetaObject):
            continue

        covered = _identity_field_names(node)

        for field in node.fields():
            if field.attr("filterable") is not True:
                continue
            if field.name in covered:
                continue
            if field.attr("db.indexed") is True:
                continue
            warnings.append(
                f'[filterable-without-index] field "{node.name}.{field.name}" has @filterable: true '
                f"but is not part of any identity. Filtering on this field will sequential-scan. "
                f"Add @db.indexed: true to the field (when supported), or remove @filterable: true."
            )


# ---------------------------------------------------------------------------
# Pass: field.object @storage validation
# ---------------------------------------------------------------------------
# Two cross-port rules:
#   1. @storage="flattened" + isArray → ERR_STORAGE_FLATTENED_ARRAY (flattened
#      materialises one-column-per-field; arrays require @storage="jsonb").
#   2. @storage set without @objectRef → ERR_STORAGE_WITHOUT_OBJECT_REF
#      (storage shape only applies to referenced objects).


def _validate_field_object_storage(root: MetaData, errors: list[MetaError]) -> None:
    for node in _walk(root):
        if node.type != TYPE_FIELD or node.sub_type != FIELD_SUBTYPE_OBJECT:
            continue
        storage = node.attr(FIELD_ATTR_STORAGE)
        if storage is None:
            continue
        object_ref = node.attr(FIELD_ATTR_OBJECT_REF)
        if not (isinstance(object_ref, str) and object_ref):
            errors.append(MetaError(
                code=ErrorCode.ERR_STORAGE_WITHOUT_OBJECT_REF,
                message=(
                    f"field.object '{node.name}' has @storage but no @objectRef — "
                    f"@storage shape only applies to referenced objects"
                ),
                envelope=node.source,
            ))
            continue
        if storage == "flattened" and getattr(node, "is_array", False):
            errors.append(MetaError(
                code=ErrorCode.ERR_STORAGE_FLATTENED_ARRAY,
                message=(
                    f"field.object '{node.name}' @storage=\"flattened\" cannot be combined "
                    f"with isArray=true (use @storage=\"jsonb\" for owned-array storage)"
                ),
                envelope=node.source,
            ))


# ---------------------------------------------------------------------------
# Pass: template.* validation (FR-004)
# ---------------------------------------------------------------------------
# Four cross-port rules:
#   R1 — template.prompt requires @payloadRef     → ERR_MISSING_REQUIRED_ATTR
#   R2 — @payloadRef resolves to a root-level object.value → ERR_INVALID_TEMPLATE
#   R3 — @requiredSlots entries are fields on the payload → ERR_INVALID_TEMPLATE
#   R4 — @format (if set) is in the closed enum set → ERR_BAD_ATTR_VALUE
#        (handled by AttrSchema.allowed_values already; included for parity).


def _validate_templates(root: MetaData, errors: list[MetaError]) -> None:
    objects_by_name: dict[str, MetaData] = {}
    for child in root.own_children():
        if child.type == TYPE_OBJECT:
            objects_by_name.setdefault(child.name, child)

    for tpl in root.own_children():
        if tpl.type != TYPE_TEMPLATE:
            continue
        is_prompt = tpl.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT
        payload_ref = tpl.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
        has_payload_ref = isinstance(payload_ref, str) and payload_ref

        # R1 — prompt requires @payloadRef
        if is_prompt and not has_payload_ref:
            errors.append(MetaError(
                code=ErrorCode.ERR_MISSING_REQUIRED_ATTR,
                message=f"template.prompt '{tpl.name}' is missing required @payloadRef",
                envelope=tpl.source,
            ))
            continue

        if not has_payload_ref:
            continue

        # R2 — @payloadRef must resolve to a root-level object.value
        # FR5d — @payloadRef is a reference; emit format=resolved with
        # referrer=template FQN, target=the unresolved payloadRef string.
        payload = objects_by_name.get(payload_ref)
        if payload is None or payload.sub_type != OBJECT_SUBTYPE_VALUE:
            errors.append(MetaError(
                code=ErrorCode.ERR_INVALID_TEMPLATE,
                message=(
                    f"template '{tpl.name}' @payloadRef '{payload_ref}' "
                    f"does not resolve to an object.value at root"
                ),
                envelope=resolved_source(tpl.source, tpl.fqn(), payload_ref),
            ))
            continue

        # R3 — required-slots membership
        if is_prompt:
            slots_raw = tpl.attr(tc.TEMPLATE_ATTR_REQUIRED_SLOTS)
            slots = _parse_string_list(slots_raw)
            if slots:
                payload_fields = {f.name for f in payload.own_children() if f.type == TYPE_FIELD}
                for slot in slots:
                    if slot not in payload_fields:
                        # FR5d — @requiredSlots is a field-on-payload reference;
                        # emit format=resolved with target=`payloadRef.slot`
                        # (the dotted ref that did not resolve to a payload
                        # field). Mirrors TS validation-passes.ts L122-137.
                        errors.append(MetaError(
                            code=ErrorCode.ERR_INVALID_TEMPLATE,
                            message=(
                                f"template.prompt '{tpl.name}' @requiredSlots includes '{slot}' "
                                f"which is not a field on payload '{payload_ref}'"
                            ),
                            envelope=resolved_source(
                                tpl.source, tpl.fqn(), f"{payload_ref}.{slot}",
                            ),
                        ))


def _parse_string_list(raw: object) -> tuple[str, ...]:
    if raw is None:
        return ()
    if isinstance(raw, str):
        return tuple(s.strip() for s in raw.split(",") if s.strip())
    if isinstance(raw, (list, tuple)):
        return tuple(str(x) for x in raw)
    return ()
