"""Loader validation passes — run after super-resolution, before freeze (ADR-0002).

Errors are cross-node checks that cannot live on a single node. Each pass
appends to `errors` (list[MetaError]) or `warnings` (list[str]).
Error message text is free; error CODES are the conformance contract.
Warning strings are byte-identical to the expected-warnings fixtures.
"""
from __future__ import annotations

import math
import re

from ..errors import ErrorCode, MetaError
from ..source.error_source import LoaderWarning
from .validate_source_physical_names import validate_source_physical_names
from .validate_field_readonly import validate_field_readonly
from .validate_discriminator import validate_discriminator
from .validate_source_parameter_ref import validate_source_parameter_ref
from ..meta.core.field.field_constants import (
    ENUM_MEMBER_PATTERN,
    FIELD_ATTR_COERCE_DEFAULT,
    FIELD_ATTR_DEFAULT,
    FIELD_ATTR_OBJECT_REF,
    FIELD_ATTR_STORAGE,
    FIELD_ATTR_VALUE_TYPE,
    FIELD_ATTR_VALUES,
    FIELD_SUBTYPE_BOOLEAN,
    FIELD_SUBTYPE_CURRENCY,
    FIELD_SUBTYPE_DATE,
    FIELD_SUBTYPE_DECIMAL,
    FIELD_SUBTYPE_DOUBLE,
    FIELD_SUBTYPE_ENUM,
    FIELD_SUBTYPE_FLOAT,
    FIELD_SUBTYPE_INT,
    FIELD_SUBTYPE_LONG,
    FIELD_SUBTYPE_MAP,
    FIELD_SUBTYPE_OBJECT,
    FIELD_SUBTYPE_STRING,
    FIELD_SUBTYPE_TIME,
    FIELD_SUBTYPE_TIMESTAMP,
    FIELD_SUBTYPE_UUID,
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
from ..meta.persistence.source.source_constants import (
    SOURCE_READ_ONLY_KINDS,
    SOURCE_ROLE_PRIMARY,
)
from ..meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_PROPERTIES,
    ATTR_SUBTYPE_STRINGARRAY,
)
from ..registry import AttrSchema, ChildRule, TypeRegistry
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
from ..meta.core.relationship.relationship_constants import (
    CARDINALITY_MANY,
    CARDINALITY_ONE,
    RELATIONSHIP_ATTR_CARDINALITY,
    RELATIONSHIP_ATTR_OBJECT_REF,
    RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
    RELATIONSHIP_ATTR_SYMMETRIC,
    RELATIONSHIP_ATTR_THROUGH,
)
from ..meta.core.identity.identity_constants import (
    IDENTITY_SUBTYPE_PRIMARY,
    IDENTITY_SUBTYPE_REFERENCE,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
)
from ..shared.separators import PACKAGE_SEP
from ..meta.core.object.object_constants import (
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_PROJECTION,
    OBJECT_SUBTYPE_VALUE,
)
from ..meta.core.identity.identity_constants import IDENTITY_ATTR_FIELDS
from ..source import resolved_source

# A subtype-specific template attr is valid ONLY on the subtype it is registered
# for. The metamodel registers these per-subtype (see the core_types template block),
# but the lenient loader does not reject a misplaced one — _validate_templates does.
# Mirrors the per-subtype TEMPLATE_ATTRS_MAP split across the other ports.
_TEMPLATE_SUBTYPE_ONLY_ATTRS: dict[str, str] = {
    tc.TEMPLATE_ATTR_MAX_TOKENS: tc.TEMPLATE_SUBTYPE_PROMPT,
    tc.TEMPLATE_ATTR_REQUIRED_SLOTS: tc.TEMPLATE_SUBTYPE_PROMPT,
    tc.TEMPLATE_ATTR_MODEL: tc.TEMPLATE_SUBTYPE_PROMPT,
    tc.TEMPLATE_ATTR_RESPONSE_REF: tc.TEMPLATE_SUBTYPE_PROMPT,
    tc.TEMPLATE_ATTR_PROMPT_STYLE: tc.TEMPLATE_SUBTYPE_OUTPUT,
    tc.TEMPLATE_ATTR_KIND: tc.TEMPLATE_SUBTYPE_OUTPUT,
    tc.TEMPLATE_ATTR_SUBJECT_REF: tc.TEMPLATE_SUBTYPE_OUTPUT,
    tc.TEMPLATE_ATTR_HTML_BODY_REF: tc.TEMPLATE_SUBTYPE_OUTPUT,
    tc.TEMPLATE_ATTR_TEXT_BODY_REF: tc.TEMPLATE_SUBTYPE_OUTPUT,
    tc.TEMPLATE_ATTR_TOOL_NAME: tc.TEMPLATE_SUBTYPE_TOOLCALL,
}

# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_validations(
    root: MetaData,
    registry: TypeRegistry,
    errors: list[MetaError],
    warnings: list[str],
    envelope_warnings: list[LoaderWarning] | None = None,
    strict: bool = False,
) -> None:
    """Run all validation passes in order.

    Passes are designed to be additive: later tasks add passes here.

    ``envelope_warnings`` (optional) — FR5c-style envelope warning channel for
    validation passes that produce envelope-shaped warnings (e.g. FR-016's
    ``WARN_LEGACY_PHYSICAL_NAME_ALIAS``). When ``None``, those passes still
    push the warning code onto the legacy ``warnings`` channel so existing
    consumers see something.
    """
    _validate_attr_schema(root, registry, errors, strict)
    _validate_enum_values(root, errors)
    _validate_field_defaults(root, errors)
    _validate_db_column_type(root, errors)
    _validate_datagrid_sort_fields(root, errors)
    _validate_datagrid_filter_values(root, errors)
    _validate_origin_paths(root, errors)
    # FR-024 B6 — an entity's origin-bearing field needs a read-capable source.
    _validate_derived_field_providability(root, errors)
    _validate_relationships(root, errors)
    # Phase 2 — validation DERIVED FROM THE TYPE REGISTRY: each node's TypeDefinition
    # carries its reference descriptors (relationship @objectRef, identity.reference
    # @references for core; a downstream provider's type carries its own) + validator,
    # run as one recursive walk over a built-once symbol table.
    if registry is not None:
        from .registered_validation import run as _run_registered
        errors.extend(_run_registered(root, registry))
    _validate_one_primary_source(root, errors)
    # FR-016 / ADR-0018 — per-kind physical-name aliases on source.rdb.
    validate_source_physical_names(root, errors, envelope_warnings, warnings)
    # FR-013 — field-level @readOnly cross-attribute rules.
    validate_field_readonly(root, errors, envelope_warnings, warnings)
    # FR-014 — TPH discriminator cross-attribute rules.
    validate_discriminator(root, errors)
    # FR-015 — source.rdb @parameterRef typed-input rules.
    validate_source_parameter_ref(root, errors)
    _validate_field_object_storage(root, errors)
    # field.map — exactly one of @valueType (scalar) or @objectRef (VO), and
    # @valueType (when set) must name a known scalar subtype.
    _validate_field_map(root, errors)
    _validate_templates(root, errors)
    _validate_subtype_rules(root, errors, warnings)
    # FR-024 B3 — projection identity pass-through + key correspondence.
    _validate_identity_passthrough(root, errors)
    _validate_max_occurs(root, registry, errors)
    _validate_filterable_has_index(root, warnings)
    # SP-H Unit9 — @filterable on a subtype with no operator band → error.
    _validate_filterable_has_supported_ops(root, errors)


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
    if value_type == "stringarray":
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


# The any-name / any-subtype wildcard a ChildRule field may carry. Mirrors TS's
# CHILD_RULE_WILDCARD in shared/structural.ts.
_CHILD_RULE_WILDCARD = "*"


def _child_rule_admits(rule: "ChildRule", child: MetaData) -> bool:
    """Whether *rule* admits *child* under the shared wildcard match semantics.

    childType / childName may be ``"*"``; childSubType may be ``"*"``, a single
    subtype, or a LIST of subtypes (FR-033). Mirrors the TS ``childRuleMatches``
    in registry.ts used by Check 0b in attr-schema-validate.ts.
    """
    if rule.child_type != _CHILD_RULE_WILDCARD and rule.child_type != child.type:
        return False

    sub = rule.child_sub_type
    if isinstance(sub, list):
        if child.sub_type not in sub:
            return False
    elif sub != _CHILD_RULE_WILDCARD and sub != child.sub_type:
        return False

    if rule.child_name != _CHILD_RULE_WILDCARD and rule.child_name != child.name:
        return False
    return True


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
    strict: bool = False,
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

        # --- Check 0 (ADR-0023): strict-load undeclared-attr rejection ---
        #
        # Runs BEFORE the `not schemas` early-return: a node type with no
        # per-type schema and no common attrs must still reject an authored
        # @-attr under strict. Own-attrs only — an inherited/overlaid declared
        # attr was validated on its declaring node and never appears in
        # own_meta_attrs(). An own attr matching neither a per-type schema entry
        # nor a commonAttr is a made-up attribute → ERR_UNKNOWN_ATTR (closing the
        # open policy). In lax mode (the default) this is a no-op, preserving the
        # legacy open-attr behavior so downstream apps can loosen.
        if strict:
            for attr_node in node.own_meta_attrs():
                # attr.properties is a first-class, registered, canonical attr
                # subtype whose designed purpose is an arbitrary-named structural
                # property bag (its NAME is intentionally not declared by any
                # per-type schema). It is sanctioned vocabulary, not a made-up
                # attribute, so strict-attr exempts a materialized properties-attr
                # from ERR_UNKNOWN_ATTR. (A typo'd plain @-attr still fails — only
                # the `properties` subtype is exempt.) Mirrors the TS reference
                # Check-0 in attr-schema-validate.ts.
                if attr_node.sub_type == ATTR_SUBTYPE_PROPERTIES:
                    continue
                if attr_node.name not in schema_by_name:
                    errors.append(
                        MetaError(
                            f"Unknown attribute '@{attr_node.name}' on "
                            f"{_node_label(node)} — not declared by any registered "
                            f"provider for {node.type}.{node.sub_type}",
                            ErrorCode.ERR_UNKNOWN_ATTR,
                            envelope=node.source,
                        )
                    )

        # --- Check 0b (FR-033): strict-load structural-child placement ---
        #
        # The structural analogue of Check 0. A STRUCTURAL child (field/identity/
        # source/validator/… — attrs never appear in own_children(); they live in
        # own_meta_attrs()) must be admitted by the parent's registered child_rules
        # under the same wildcard match semantics used everywhere (childType /
        # childSubType / childName may be "*", and childSubType may be a list). A
        # child the rules do not admit → ERR_CHILD_NOT_ALLOWED (the structural
        # analogue of Check 0's ERR_UNKNOWN_ATTR). Strict-load only; lax keeps the
        # legacy open policy. An UNREGISTERED parent cannot be judged here
        # (ERR_UNKNOWN_TYPE / ERR_UNKNOWN_SUBTYPE is reported elsewhere) — skip so
        # we never double-report. Mirrors the TS reference Check 0b in
        # attr-schema-validate.ts.
        if strict:
            parent_def = registry.find(node.type, node.sub_type)
            if parent_def is not None:
                rules = parent_def.child_rules
                for child in node.own_children():
                    if not any(_child_rule_admits(r, child) for r in rules):
                        errors.append(
                            MetaError(
                                f"Child {_node_label(child)} is not allowed under "
                                f"{_node_label(node)} — no registered child rule for "
                                f"{node.type}.{node.sub_type} admits "
                                f"(type='{child.type}', subType='{child.sub_type}', "
                                f"name='{child.name}')",
                                ErrorCode.ERR_CHILD_NOT_ALLOWED,
                                envelope=node.source,
                            )
                        )

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

            # Check 2: type validation. An array-valued attr (the `string` +
            # is_array model that replaced the `stringarray` subtype) is validated
            # as a string array.
            effective_value_type = (
                ATTR_SUBTYPE_STRINGARRAY
                if schema.value_type is not None
                and (schema.is_array or schema.value_type == ATTR_SUBTYPE_STRINGARRAY)
                else schema.value_type
            )
            if effective_value_type is not None:
                if not _type_ok(raw_value, effective_value_type):
                    errors.append(
                        MetaError(
                            f"{_node_label(node)} attribute '@{attr_node.name}' has value "
                            f"{raw_value!r} which does not match expected type '{effective_value_type}'",
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
# Pass: generalized @default per-type validation (Phase B)
# ---------------------------------------------------------------------------
# @default is registered on the field base (FIELD_ATTR_DEFAULT) so any field subtype
# may declare it. Its string value must coerce to the field's type:
#   - int / long / currency    → integer parse (or finite-number truncation fallback)
#   - double / float / decimal → finite-number parse
#   - boolean                  → exact "true"|"false"
#   - enum                     → member of @values (handled by _validate_enum_fr011_attrs)
#   - string / date / time / object / others → any value allowed
# A violation emits ERR_BAD_ATTR_VALUE, mirroring the enum @default membership check.
# Own-only: validates @default declared on THIS node. Mirrors Java ValidationPhase
# .validateFieldDefaults (cross-port) + the engine's Coerce.scalar parse semantics.

_INT_SUBTYPES = (FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY)
_NUM_SUBTYPES = (FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL)


def _parses_as_finite_number(s: str) -> bool:
    try:
        return math.isfinite(float(s.strip()))
    except ValueError:
        return False


def _parses_as_long(s: str) -> bool:
    t = s.strip()
    try:
        int(t)
        return True
    except ValueError:
        # Accept a finite decimal that truncates to an integer value (matches the
        # engine's Coerce.scalar INT/LONG fallback).
        return _parses_as_finite_number(t)


def _validate_field_defaults(root: MetaData, errors: list[MetaError]) -> None:
    for node in _walk(root):
        if node.type != TYPE_FIELD:
            continue
        # Enum @default membership is validated by _validate_enum_fr011_attrs.
        if node.sub_type == FIELD_SUBTYPE_ENUM:
            continue
        # Own-only: node.attr() reads only this node's own attrs.
        own = node.attr(FIELD_ATTR_DEFAULT)
        if not isinstance(own, str):
            continue

        sub = node.sub_type
        if sub in _INT_SUBTYPES:
            ok = _parses_as_long(own)
        elif sub in _NUM_SUBTYPES:
            ok = _parses_as_finite_number(own)
        elif sub == FIELD_SUBTYPE_BOOLEAN:
            ok = own in ("true", "false")
        else:
            ok = True  # string / date / time / object / others — any value allowed

        if not ok:
            errors.append(
                MetaError(
                    f"{_node_label(node)} attribute '@{FIELD_ATTR_DEFAULT}' value "
                    f"{own!r} is not coercible to the field's type",
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

# value → the field subtype it is legal on (Phase 1: three surviving values).
# uuid_array / text_array are REMOVED — derive from field.uuid/field.string + isArray.
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
# string / enum  → eq, ne, in, like, isNull
# uuid           → eq, ne, in, isNull  (no like — not a substring type, no ordering)
# boolean        → eq, isNull
# numerics + currency + temporal → eq, ne, gt, gte, lt, lte, in, isNull

_OPS_STRING: frozenset[str] = frozenset({"eq", "ne", "in", "like", "isNull"})
_OPS_UUID: frozenset[str] = frozenset({"eq", "ne", "in", "isNull"})
_OPS_BOOLEAN: frozenset[str] = frozenset({"eq", "isNull"})
_OPS_NUMERIC_TEMPORAL: frozenset[str] = frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"})

# string-shaped subtypes (string op band): string + enum.
_STRING_SUBTYPES: frozenset[str] = frozenset({"string", "enum"})
# currency = integer minor units (an orderable number) → numeric band.
_NUMERIC_TEMPORAL_SUBTYPES: frozenset[str] = frozenset(
    {"int", "long", "double", "float", "decimal", "currency", "date", "time", "timestamp"}
)


def ops_for_subtype(field_subtype: str) -> frozenset[str]:
    """Return the set of allowed filter operators for a given field subtype.

    Mirrors the ops-per-subtype allow-table from query-constants.ts.
    """
    if field_subtype in _STRING_SUBTYPES:
        return _OPS_STRING
    if field_subtype == "uuid":
        return _OPS_UUID
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
            if f.attrs().get("filterable") is True
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
    """Return a ref → MetaObject index of all top-level objects in *root*.

    FR-032 (ADR-0032): origin ref heads (@from/@of/@via) and relationship
    @objectRef values are FULLY QUALIFIED after the desugar/corpus sweep
    (e.g. ``acme::commerce::Program``). Index each object under its bare
    ``name``, its ``fqn()`` AND its package-folded ``resolution_key()`` so a
    lookup FQN-matches regardless of which canonical form the ref carries.
    Mirrors TS ``refMatchesObject`` / the C# @parameterRef index.
    """
    index: dict[str, MetaObject] = {}
    for child in root.own_children():
        if child.type == TYPE_OBJECT and isinstance(child, MetaObject):
            if child.name:
                index[child.name] = child
                index[child.fqn()] = child
                index[child.resolution_key()] = child
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
) -> tuple[MetaObject, MetaData] | None:
    """Validate a dotted 'Entity.fieldName' reference.

    Returns the resolved (entity, field-node) on full success (FR-024 B5 needs
    the entity for @via inference; B6 agreement needs the field node), or None
    when any error was pushed (malformed shape / unknown entity / unknown field).

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
        return None
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
        return None
    field_node = next((f for f in entity.fields() if f.name == field_name), None)
    if field_node is None:
        # FR5d — entity resolved, field on it did not. target = full ref.
        known = sorted(f.name for f in entity.fields())
        errors.append(
            MetaError(
                f"{context} @{attr_name}='{ref}' references field '{field_name}' which does "
                f"not exist on entity '{entity_name}' (known fields: {known})",
                ErrorCode.ERR_INVALID_ORIGIN,
                envelope=resolved_source(origin_node.source, referrer, ref),
            )
        )
        return None
    return (entity, field_node)


def _validate_via_path(
    via: str,
    context: str,
    object_index: dict[str, MetaObject],
    errors: list[MetaError],
    origin_node: MetaData,
    referrer: str,
) -> list[MetaData] | None:
    """Validate a dotted relationship path 'Entity.rel1[.rel2...]'.

    Returns the walked relationship hop nodes (in path order) on full success
    (FR-024 B5 runs the cardinality checks over them); appends ERR_INVALID_ORIGIN
    and returns None if not.

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
        return None

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
        return None

    # FR5d — track the deepest-valid-prefix as we walk. The prefix starts at
    # the entity name (resolved above) and grows by one segment per successful
    # relationship hop. On hop failure the message names the prefix that DID
    # resolve so authors can fix multi-hop typos quickly.
    valid_segments: list[str] = [current_name]
    hops: list[MetaData] = []
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
            return None

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
            return None

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
            return None

        valid_segments.append(rel_name)
        hops.append(rel_node)
        current_entity = next_entity

    return hops


# ---------------------------------------------------------------------------
# FR-024 B5/B6 helpers — base-entity derivation, single-hop-unique @via
# inference, origin cardinality, extends/origin agreement (spec §5–§6; ADR-0029).
# Mirror the TS reference (validation-passes.ts).
# ---------------------------------------------------------------------------


def _hop_cardinality(rel: MetaData) -> str | None:
    """A hop relationship's effective @cardinality, or None when not declared."""
    v = rel.attr(RELATIONSHIP_ATTR_CARDINALITY)
    return v if isinstance(v, str) else None


def _ref_named_owner(node: MetaData, object_index: dict[str, MetaObject]) -> MetaData | None:
    """The entity NAMED by a node's dotted extends ref — the OWNER part of
    ``<owner>.<child>...``. Differs from ``super_data.parent`` when the resolved
    child is INHERITED: ``Product.id`` selecting BaseEntity's identity through
    Product must anchor Product (what the author wrote), not BaseEntity."""
    ref = node.super_ref
    if not ref:
        return None
    last_sep = ref.rfind(PACKAGE_SEP)
    tail = ref if last_sep == -1 else ref[last_sep + len(PACKAGE_SEP):]
    dot = tail.find(".")
    if dot <= 0:
        return None
    return object_index.get(tail[:dot])


def _is_base_relation_target(target: MetaData, base: MetaData, host: MetaData) -> bool:
    """True when the @from/@of target IS the host's base relation: the base
    entity itself, or an ancestor on the base's (or the host's) whole-object
    extends chain (the legacy ``Summary extends Program`` style)."""
    cur: MetaData | None = base
    while cur is not None:
        if cur is target:
            return True
        cur = cur.super_data
    cur = host
    while cur is not None:
        if cur is target:
            return True
        cur = cur.super_data
    return False


def _derive_base_entity(
    obj: MetaData,
    object_index: dict[str, MetaObject],
    field_name: str,
    origin_source: object,
    errors: list[MetaError],
) -> MetaData | None:
    """Derive the BASE entity a no-@via origin path anchors at (spec §5)."""
    if obj.sub_type != OBJECT_SUBTYPE_PROJECTION:
        return obj

    # 1) The extended identity anchors the base entity (declared, not inferred).
    for identity in (c for c in obj.own_children() if c.type == TYPE_IDENTITY):
        extended = identity.super_data
        if extended is not None and extended.type == TYPE_IDENTITY:
            named = _ref_named_owner(identity, object_index)
            if named is not None:
                return named
            owner = extended.parent
            if owner is not None and owner.type == TYPE_OBJECT:
                return owner

    # 2) Fallback: the single distinct entity targeted by plain field-extends.
    targets: list[MetaData] = []
    seen: set[int] = set()
    for f in (c for c in obj.own_children() if c.type == TYPE_FIELD):
        sup = f.super_data
        if sup is None:
            continue
        named = _ref_named_owner(f, object_index)
        owner = named if named is not None else sup.parent
        if (
            owner is not None
            and owner.type == TYPE_OBJECT
            and owner.sub_type != OBJECT_SUBTYPE_VALUE
            and owner is not obj
            and id(owner) not in seen
        ):
            seen.add(id(owner))
            targets.append(owner)
    if len(targets) == 1:
        return targets[0]
    if len(targets) > 1:
        names = ", ".join(f'"{t.name}"' for t in targets)
        errors.append(
            MetaError(
                f"origin on {obj.name}.{field_name}: cannot derive the base entity — the "
                f"projection's fields extend multiple entities ({names}) and no identity "
                f"extends an entity identity. Declare an extended identity to anchor the "
                f"base entity (FR-024).",
                ErrorCode.ERR_AMBIGUOUS_PATH,
                envelope=origin_source,
            )
        )
    else:
        errors.append(
            MetaError(
                f"origin on {obj.name}.{field_name}: cannot derive the base entity for @via "
                f"inference — the projection has no extended identity and no entity-targeted "
                f"field extends. Declare an extended identity or an explicit @via (FR-024).",
                ErrorCode.ERR_INVALID_ORIGIN,
                envelope=origin_source,
            )
        )
    return None


def _infer_via_single_hop(
    base: MetaData,
    target_entity: MetaData,
    obj: MetaData,
    field_name: str,
    from_attr: str,
    ctx: str,
    origin_source: object,
    referrer: str,
    errors: list[MetaError],
) -> list[MetaData] | None:
    """Single-hop-unique @via inference (ADR-0029 decision 5): scan the base
    entity's effective relationships for those whose @objectRef resolves to the
    @from/@of target entity. Exactly one → the inferred path. Zero →
    ERR_INVALID_ORIGIN. More than one → ERR_AMBIGUOUS_PATH."""
    candidates = [
        rel
        for rel in base.children()
        if rel.type == TYPE_RELATIONSHIP
        and isinstance(rel.attr(RELATIONSHIP_ATTR_OBJECT_REF), str)
        and _strip_package(rel.attr(RELATIONSHIP_ATTR_OBJECT_REF)) == target_entity.name
    ]
    if len(candidates) == 1:
        return [candidates[0]]
    if len(candidates) == 0:
        errors.append(
            MetaError(
                f"{ctx} '{from_attr}': no @via and no single-hop relationship from base "
                f"entity '{base.name}' to '{target_entity.name}' — cannot infer the path. "
                f"Declare @via explicitly (multi-hop paths are always explicit; ADR-0029).",
                ErrorCode.ERR_INVALID_ORIGIN,
                envelope=resolved_source(origin_source, referrer, from_attr),
            )
        )
        return None
    names = ", ".join(f'"{r.name}"' for r in candidates)
    errors.append(
        MetaError(
            f"{ctx} '{from_attr}': no @via and {len(candidates)} relationships from base "
            f"entity '{base.name}' to '{target_entity.name}' ({names}) — ambiguous. Declare "
            f"@via naming one of them (ADR-0029).",
            ErrorCode.ERR_AMBIGUOUS_PATH,
            envelope=resolved_source(origin_source, referrer, from_attr),
        )
    )
    return None


def _check_passthrough_cardinality(
    hops: list[MetaData], field_name: str, origin_source: object, errors: list[MetaError]
) -> None:
    """ADR-0029 decision 6 — a passthrough via-path must be effectively to-one at
    EVERY hop. A hop is to-many only when it DECLARES @cardinality "many"."""
    for rel in hops:
        if _hop_cardinality(rel) == CARDINALITY_MANY:
            errors.append(
                MetaError(
                    f"origin.passthrough on {field_name}: @via hop '{rel.name}' is to-many "
                    f'(@cardinality "{CARDINALITY_MANY}") — a row-multiplying passthrough — '
                    f"you meant aggregate (ADR-0029).",
                    ErrorCode.ERR_ORIGIN_CARDINALITY,
                    envelope=origin_source,
                )
            )
            return


def _check_aggregate_cardinality(
    hops: list[MetaData], field_name: str, origin_source: object, errors: list[MetaError]
) -> None:
    """ADR-0029 decision 6 — an aggregate via-path must contain at least one
    to-many hop. Conservative: fires only when PROVABLY to-one (every hop
    declares @cardinality "one")."""
    if not hops:
        return
    if all(_hop_cardinality(rel) == CARDINALITY_ONE for rel in hops):
        errors.append(
            MetaError(
                f"origin.aggregate on {field_name}: every @via hop is to-one "
                f'(@cardinality "{CARDINALITY_ONE}") — aggregating over a to-one path — '
                f"you meant passthrough (ADR-0029).",
                ErrorCode.ERR_ORIGIN_CARDINALITY,
                envelope=origin_source,
            )
        )


def _check_extends_origin_agreement(
    field: MetaData,
    from_field: MetaData,
    from_attr: str,
    obj: MetaData,
    origin_source: object,
    referrer: str,
    errors: list[MetaError],
) -> None:
    """FR-024 B6 (spec §4; ADR-0029 decision 7) — when a field declares BOTH an
    entity-nested extends (shape lineage) and an origin.passthrough @from (data
    lineage), the resolved @from target must be the same node as the field's
    resolved extends target, or appear on its extends chain."""
    sup = field.super_data
    if sup is None or sup.type != TYPE_FIELD:
        return
    sup_owner = sup.parent
    if sup_owner is None or sup_owner.type != TYPE_OBJECT:
        return
    cur: MetaData | None = sup
    while cur is not None:
        if cur is from_field:
            return  # shape lineage and data lineage agree
        cur = cur.super_data
    errors.append(
        MetaError(
            f"origin.passthrough on {obj.name}.{field.name}: @from '{from_attr}' disagrees "
            f"with the field's extends target '{sup_owner.name}.{sup.name}' — extends (shape "
            f"lineage) and origin.passthrough (data lineage) must point at the same entity "
            f"field (FR-024).",
            ErrorCode.ERR_EXTENDS_ORIGIN_MISMATCH,
            envelope=resolved_source(origin_source, referrer, from_attr),
        )
    )


def _validate_origin_paths(
    root: MetaData,
    errors: list[MetaError],
) -> None:
    """Validate @from/@of/@via on origin.passthrough/aggregate, plus FR-024 B5/B6
    (@via single-hop inference, cardinality, extends/origin agreement).

    Errors use ERR_INVALID_ORIGIN / ERR_AMBIGUOUS_PATH / ERR_ORIGIN_CARDINALITY /
    ERR_EXTENDS_ORIGIN_MISMATCH. Only validates; does NOT alter the tree.
    """
    object_index = _build_object_index(root)

    for node in _walk(root):
        if node.type != TYPE_FIELD:
            continue
        # The object that owns this field (the field's parent in source-v2).
        obj = node.parent if hasattr(node, "parent") else None
        if obj is None or obj.type != TYPE_OBJECT:
            continue
        # FR-024 B5: object.value hosts are EXEMPT from @via inference and
        # cardinality checks — a value's origin.passthrough is FR-015 parameter
        # lineage (constructed, not assembled). @from is still resolution-checked.
        is_value_host = obj.sub_type == OBJECT_SUBTYPE_VALUE
        for origin in node.own_children():
            if origin.type != TYPE_ORIGIN:
                continue
            ctx = f"field '{node.name}' origin.{origin.sub_type}"
            # FR5d — referrer is `<host-FQN>::<fieldName>`.
            referrer = (
                f"{obj.fqn()}::{node.name}"
                if hasattr(obj, "fqn")
                else (node.fqn() if hasattr(node, "fqn") else node.name)
            )

            if origin.sub_type == ORIGIN_SUBTYPE_PASSTHROUGH:
                from_ref = origin.attr(ORIGIN_ATTR_FROM)
                if not isinstance(from_ref, str) or not from_ref:
                    errors.append(
                        MetaError(
                            f"{ctx} is missing required attribute '@{ORIGIN_ATTR_FROM}'",
                            ErrorCode.ERR_INVALID_ORIGIN,
                            envelope=origin.source,
                        )
                    )
                    continue
                from_target = _validate_entity_field_ref(
                    from_ref, ORIGIN_ATTR_FROM, ctx, object_index, errors, origin, referrer
                )
                # FR-024 B6 — extends/origin agreement (host-agnostic).
                if from_target is not None:
                    _check_extends_origin_agreement(
                        node, from_target[1], from_ref, obj, origin.source, referrer, errors
                    )
                via = origin.attr(ORIGIN_ATTR_VIA)
                if isinstance(via, str) and via:
                    hops = _validate_via_path(via, ctx, object_index, errors, origin, referrer)
                    if hops is not None:
                        _check_passthrough_cardinality(hops, node.name, origin.source, errors)
                elif from_target is not None and not is_value_host:
                    # FR-024 §6 — no @via: derive the base entity; a @from on the
                    # base relation itself is a plain base column (no checks);
                    # otherwise infer the single-hop-unique path and gate cardinality.
                    base = _derive_base_entity(
                        obj, object_index, node.name, origin.source, errors
                    )
                    if base is not None and not _is_base_relation_target(
                        from_target[0], base, obj
                    ):
                        hops = _infer_via_single_hop(
                            base, from_target[0], obj, node.name, from_ref, ctx,
                            origin.source, referrer, errors,
                        )
                        if hops is not None:
                            _check_passthrough_cardinality(
                                hops, node.name, origin.source, errors
                            )

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
                    continue
                # NOTE (FR-024 B6): NO extends/origin agreement on aggregates —
                # an aggregate computes something new (spec §4 is passthrough-only).
                of_target = _validate_entity_field_ref(
                    of_ref, ORIGIN_ATTR_OF, ctx, object_index, errors, origin, referrer
                )
                via = origin.attr(ORIGIN_ATTR_VIA)
                if isinstance(via, str) and via:
                    hops = _validate_via_path(via, ctx, object_index, errors, origin, referrer)
                    if hops is not None:
                        _check_aggregate_cardinality(hops, node.name, origin.source, errors)
                    continue
                # FR-024 §6 — no @via on an aggregate: inference applies only when
                # @of targets a non-base entity from a non-value host.
                if of_target is None:
                    continue
                if is_value_host:
                    errors.append(
                        MetaError(
                            f"{ctx} is missing required attribute '@{ORIGIN_ATTR_VIA}' "
                            f"(aggregates require a relationship path)",
                            ErrorCode.ERR_INVALID_ORIGIN,
                            envelope=origin.source,
                        )
                    )
                    continue
                base = _derive_base_entity(
                    obj, object_index, node.name, origin.source, errors
                )
                if base is None:
                    continue
                if _is_base_relation_target(of_target[0], base, obj):
                    errors.append(
                        MetaError(
                            f"{ctx} is missing required attribute '@{ORIGIN_ATTR_VIA}' "
                            f"(aggregates require a relationship path)",
                            ErrorCode.ERR_INVALID_ORIGIN,
                            envelope=origin.source,
                        )
                    )
                    continue
                hops = _infer_via_single_hop(
                    base, of_target[0], obj, node.name, of_ref, ctx,
                    origin.source, referrer, errors,
                )
                if hops is not None:
                    _check_aggregate_cardinality(hops, node.name, origin.source, errors)


# ---------------------------------------------------------------------------
# Pass: M:N relationship validation (FR-017 slim vocabulary)
# ---------------------------------------------------------------------------
# Deferred-resolution validation (runs after all files load + super-resolution,
# like origin paths), enforcing the cross-port M:N contract:
#
#   (a) @symmetric:true is valid only on a self-join (@objectRef == declaring
#       entity). Otherwise ERR_BAD_ATTR_VALUE.
#   (b) @symmetric and @sourceRefField are mutually exclusive → ERR_BAD_ATTR_VALUE.
#   (c) When @through is present: the named entity must exist and declare exactly
#       two identity.reference children; @sourceRefField (if present) must match
#       one of those references' FK fields → ERR_INVALID_RELATIONSHIP.
#   (d) @through / @sourceRefField / @symmetric are invalid on a non-M:N
#       relationship (@cardinality != "many", or no @through) → ERR_INVALID_RELATIONSHIP.
#
# Own-relationships only: a relationship is validated on the entity that declares
# it (matching the own-attrs policy of the other passes). Mirrors the TS
# reference (validation-passes.ts validateRelationships).


def _strip_package(name: str) -> str:
    idx = name.rfind(PACKAGE_SEP)
    return name[idx + len(PACKAGE_SEP):] if idx >= 0 else name


def _junction_reference_fk_fields(junction: MetaData) -> list[str]:
    """FK field names declared by an entity's identity.reference children."""
    out: list[str] = []
    for child in junction.own_children():
        if child.type != TYPE_IDENTITY or child.sub_type != IDENTITY_SUBTYPE_REFERENCE:
            continue
        fields = child.attr(IDENTITY_ATTR_FIELDS)
        if isinstance(fields, str):
            first = fields.split(",")[0].strip()
            if first:
                out.append(first)
        elif isinstance(fields, (list, tuple)) and fields and isinstance(fields[0], str):
            out.append(fields[0])
    return out


def _count_junction_references(junction: MetaData) -> int:
    return sum(
        1
        for c in junction.own_children()
        if c.type == TYPE_IDENTITY and c.sub_type == IDENTITY_SUBTYPE_REFERENCE
    )


def _validate_relationships(root: MetaData, errors: list[MetaError]) -> None:
    object_index = _build_object_index(root)

    for obj in (c for c in root.own_children() if c.type == TYPE_OBJECT):
        for rel in (c for c in obj.own_children() if c.type == TYPE_RELATIONSHIP):
            through = rel.attr(RELATIONSHIP_ATTR_THROUGH)
            source_ref_field = rel.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD)
            symmetric = rel.attr(RELATIONSHIP_ATTR_SYMMETRIC) is True
            cardinality = rel.attr(RELATIONSHIP_ATTR_CARDINALITY)
            object_ref = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF)

            has_through = isinstance(through, str) and through != ""
            has_source_ref_field = (
                isinstance(source_ref_field, str) and source_ref_field != ""
            )
            is_many = cardinality == CARDINALITY_MANY
            is_m2m = has_through and is_many

            # NOTE: @objectRef existence resolution moved to the validation registry
            # (a declarative ReferenceDescriptor on relationship.* TypeDefinitions,
            # resolved by registered_validation). The M:N rules below stay here for now.

            # Rule (d): M:N-only attrs on a non-M:N relationship.
            if not is_m2m:
                if has_through:
                    errors.append(MetaError(
                        f'relationship "{obj.name}.{rel.name}" sets '
                        f'@{RELATIONSHIP_ATTR_THROUGH} but is not a M:N relationship '
                        f'(requires @{RELATIONSHIP_ATTR_CARDINALITY}: "{CARDINALITY_MANY}").',
                        ErrorCode.ERR_INVALID_RELATIONSHIP,
                        envelope=rel.source,
                    ))
                if has_source_ref_field:
                    errors.append(MetaError(
                        f'relationship "{obj.name}.{rel.name}" sets '
                        f'@{RELATIONSHIP_ATTR_SOURCE_REF_FIELD} but is not a M:N relationship.',
                        ErrorCode.ERR_INVALID_RELATIONSHIP,
                        envelope=rel.source,
                    ))
                if symmetric:
                    errors.append(MetaError(
                        f'relationship "{obj.name}.{rel.name}" sets '
                        f'@{RELATIONSHIP_ATTR_SYMMETRIC} but is not a M:N relationship.',
                        ErrorCode.ERR_INVALID_RELATIONSHIP,
                        envelope=rel.source,
                    ))
                continue

            # Rule (b): @symmetric and @sourceRefField are mutually exclusive.
            if symmetric and has_source_ref_field:
                errors.append(MetaError(
                    f'relationship "{obj.name}.{rel.name}" sets both '
                    f'@{RELATIONSHIP_ATTR_SYMMETRIC} and '
                    f'@{RELATIONSHIP_ATTR_SOURCE_REF_FIELD}; they are mutually exclusive.',
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    envelope=rel.source,
                ))

            # Rule (a): @symmetric valid only on a self-join (@objectRef == declaring entity).
            is_self_join = (
                isinstance(object_ref, str) and _strip_package(object_ref) == obj.name
            )
            if symmetric and not is_self_join:
                errors.append(MetaError(
                    f'relationship "{obj.name}.{rel.name}" sets '
                    f'@{RELATIONSHIP_ATTR_SYMMETRIC} but @{RELATIONSHIP_ATTR_OBJECT_REF} '
                    f'"{object_ref}" is not the declaring entity "{obj.name}"; '
                    f'@{RELATIONSHIP_ATTR_SYMMETRIC} is self-join-only.',
                    ErrorCode.ERR_BAD_ATTR_VALUE,
                    envelope=rel.source,
                ))

            # Rule (c): @through must name an entity declaring exactly two
            # identity.reference children.
            junction = object_index.get(_strip_package(through))  # type: ignore[arg-type]
            if junction is None:
                errors.append(MetaError(
                    f'relationship "{obj.name}.{rel.name}" '
                    f'@{RELATIONSHIP_ATTR_THROUGH} "{through}" does not resolve to an entity.',
                    ErrorCode.ERR_INVALID_RELATIONSHIP,
                    envelope=resolved_source(
                        rel.source, f"{obj.fqn()}::{rel.name}", str(through)
                    ),
                ))
                continue
            ref_count = _count_junction_references(junction)
            if ref_count != 2:
                errors.append(MetaError(
                    f'relationship "{obj.name}.{rel.name}" '
                    f'@{RELATIONSHIP_ATTR_THROUGH} "{through}" must declare exactly two '
                    f'identity.reference children (one per FK side); found {ref_count}.',
                    ErrorCode.ERR_INVALID_RELATIONSHIP,
                    envelope=rel.source,
                ))
                continue
            # @sourceRefField (if present) must match one of the junction's
            # reference FK fields.
            if has_source_ref_field:
                fk_fields = _junction_reference_fk_fields(junction)
                if source_ref_field not in fk_fields:
                    available = ", ".join(fk_fields) or "(none)"
                    errors.append(MetaError(
                        f'relationship "{obj.name}.{rel.name}" '
                        f'@{RELATIONSHIP_ATTR_SOURCE_REF_FIELD} "{source_ref_field}" '
                        f'does not match any identity.reference FK field on junction '
                        f'"{through}". Available: {available}.',
                        ErrorCode.ERR_INVALID_RELATIONSHIP,
                        envelope=rel.source,
                    ))


# NOTE: identity.reference @references resolution moved to the validation registry
# (a declarative ReferenceDescriptor with dotted_field_path on the identity.reference
# TypeDefinition, resolved by registered_validation).


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

        # FR-024 B4b (ADR-0028) — THE HARD CUTOVER: an entity's PRIMARY source
        # must be a writable kind; read-only kinds (view/materializedView/
        # storedProc/tableFunction) are legal only in non-primary (read) roles.
        # A derived read model is an object.projection. Mirrors TS
        # persistence/source/validate-source-roles.ts.
        if node.sub_type == OBJECT_SUBTYPE_ENTITY:
            for s in sources:
                if (
                    isinstance(s, MetaSource)
                    and s.role() == SOURCE_ROLE_PRIMARY
                    and s.effective_kind() in SOURCE_READ_ONLY_KINDS
                ):
                    errors.append(
                        MetaError(
                            f'entity "{node.name}" has a primary source of read-only '
                            f'kind "{s.effective_kind()}" — read-only kinds are legal '
                            f"only in non-primary roles; a derived read model is an "
                            f"object.projection (FR-024, ADR-0028)",
                            ErrorCode.ERR_ENTITY_PRIMARY_SOURCE_READONLY,
                            envelope=s.source,
                        )
                    )


# ---------------------------------------------------------------------------
# Pass: FR-024 B3 — projection identity pass-through + key correspondence
# ---------------------------------------------------------------------------
# A projection's identity is a PASS-THROUGH of an entity identity:
#   - every identity child of an object.projection MUST extend an entity identity
#     (ERR_PROJECTION_IDENTITY_NOT_EXTENDED);
#   - key correspondence: every field named by the extended identity's @fields
#     must have a local projection field extending it (ERR_IDENTITY_KEY_MISMATCH);
#   - the local key is COMPUTED on read (never written back); an explicit @fields
#     that disagrees with the computed set → ERR_IDENTITY_KEY_MISMATCH.
# Mirrors TS core/identity/validate-identity-passthrough.ts.


def _normalize_identity_fields(raw: object) -> list[str] | None:
    if raw is None:
        return None
    if isinstance(raw, (list, tuple)):
        return [str(v).strip() for v in raw]
    if isinstance(raw, str):
        return [s.strip() for s in raw.split(",") if s.strip()]
    return None


def _extends_chain_reaches(node: MetaData, target: MetaData) -> bool:
    cur = node.super_data
    while cur is not None:
        if cur is target:
            return True
        cur = cur.super_data
    return False


def _validate_identity_passthrough(root: MetaData, errors: list[MetaError]) -> None:
    for obj in (
        c
        for c in root.own_children()
        if c.type == TYPE_OBJECT and c.sub_type == OBJECT_SUBTYPE_PROJECTION
    ):
        for identity in (c for c in obj.own_children() if c.type == TYPE_IDENTITY):
            if not identity.super_ref:
                errors.append(
                    MetaError(
                        f"identity '{identity.name}' on projection '{obj.name}' must extend "
                        f'an entity identity (e.g. extends: "Customer.id") — a projection '
                        f"identity is a pass-through (FR-024)",
                        ErrorCode.ERR_PROJECTION_IDENTITY_NOT_EXTENDED,
                        envelope=identity.source,
                    )
                )
                continue

            extended = identity.super_data
            # Unresolved / non-identity target: ERR_UNRESOLVED_SUPER /
            # ERR_EXTENDS_TARGET_MISMATCH already reported by super-resolution.
            if extended is None or extended.type != TYPE_IDENTITY:
                continue
            entity = extended.parent
            if entity is None or entity.type != TYPE_OBJECT:
                continue
            owner = identity.parent
            if owner is None:
                continue

            extended_fields = (
                _normalize_identity_fields(extended.attr(IDENTITY_ATTR_FIELDS)) or []
            )
            computed: list[str] = []
            missing: list[str] = []
            for field_name in extended_fields:
                entity_field = next(
                    (
                        c
                        for c in entity.children()
                        if c.type == TYPE_FIELD and c.name == field_name
                    ),
                    None,
                )
                if entity_field is None:
                    missing.append(field_name)
                    continue
                local = next(
                    (
                        c
                        for c in owner.own_children()
                        if c.type == TYPE_FIELD
                        and _extends_chain_reaches(c, entity_field)
                    ),
                    None,
                )
                if local is None:
                    missing.append(field_name)
                    continue
                computed.append(local.name)

            if missing:
                refs = ", ".join(f"'{entity.name}.{f}'" for f in missing)
                errors.append(
                    MetaError(
                        f"identity '{identity.name}' on projection '{obj.name}' does not "
                        f"correspond to its extended identity: no local field extends {refs} "
                        f"(FR-024)",
                        ErrorCode.ERR_IDENTITY_KEY_MISMATCH,
                        envelope=identity.source,
                    )
                )
                continue

            explicit = _normalize_identity_fields(
                identity.own_attrs().get(IDENTITY_ATTR_FIELDS)
            )
            if explicit is not None and explicit != computed:
                errors.append(
                    MetaError(
                        f"identity '{identity.name}' on projection '{obj.name}' declares "
                        f"@fields [{', '.join(explicit)}] but the computed pass-through key "
                        f"is [{', '.join(computed)}] — omit @fields (it is derived) or make "
                        f"them agree (FR-024)",
                        ErrorCode.ERR_IDENTITY_KEY_MISMATCH,
                        envelope=identity.source,
                    )
                )


# ---------------------------------------------------------------------------
# Pass: FR-024 B6 — derived-field providability
# ---------------------------------------------------------------------------
# An object.ENTITY field carrying any origin.* child is derived (read-only): it
# does not exist on the writable table — a read-capable (read-only-kind) source
# must provide it on read. An entity with an origin-bearing OWN field but no
# read-capable source → ERR_DERIVED_FIELD_NO_READ_SOURCE.
# Mirrors TS validateDerivedFieldProvidability.


def _validate_derived_field_providability(
    root: MetaData, errors: list[MetaError]
) -> None:
    for obj in (
        c
        for c in root.own_children()
        if c.type == TYPE_OBJECT and c.sub_type == OBJECT_SUBTYPE_ENTITY
    ):
        has_read_capable = any(
            isinstance(s, MetaSource) and s.is_read_only()
            for s in obj.children()
            if s.type == TYPE_SOURCE
        )
        if has_read_capable:
            continue
        for field in (c for c in obj.own_children() if c.type == TYPE_FIELD):
            if not any(c.type == TYPE_ORIGIN for c in field.own_children()):
                continue
            errors.append(
                MetaError(
                    f'derived field "{obj.name}.{field.name}" carries an origin.* but '
                    f'entity "{obj.name}" declares no read-capable source — derived fields '
                    f"do not exist on the writable table. Declare a read-only source "
                    f'(e.g. source.rdb @kind "view" @role "replica") to provide it, or move '
                    f"the field to an object.projection (FR-024 §7).",
                    ErrorCode.ERR_DERIVED_FIELD_NO_READ_SOURCE,
                    envelope=field.source,
                )
            )


# ---------------------------------------------------------------------------
# Pass: subtype-rules
# ---------------------------------------------------------------------------
# object.entity with no effective primary identity and not abstract → warning.
# object.value with a primary identity → ERR_SUBTYPE_RULE_VIOLATION (error).


def _validate_max_occurs(
    root: MetaData,
    registry: TypeRegistry,
    errors: list[MetaError],
) -> None:
    """Enforce a type definition's ``max_occurs`` (e.g. identity.primary, 1 per
    entity). The safety complement to config-driven ``default_name`` — a
    singleton's static default name is collision-free only if the singleton
    constraint holds."""
    for node in _walk(root):
        counts: dict[tuple[str, str], list[MetaData]] = {}
        for child in node.own_children():
            counts.setdefault((child.type, child.sub_type), []).append(child)
        for (type_, sub_type), group in counts.items():
            definition = registry.find(type_, sub_type)
            max_occurs = definition.max_occurs if definition is not None else None
            if max_occurs is not None and len(group) > max_occurs:
                offender = group[max_occurs]
                errors.append(
                    MetaError(
                        f"{type_}.{sub_type} appears {len(group)} times under "
                        f"'{node.name}' but at most {max_occurs} is allowed",
                        ErrorCode.ERR_TOO_MANY_OCCURRENCES,
                        envelope=offender.source,
                    )
                )


# FR-024 value purity (ADR-0028): a value object is a pure data shape — it
# carries NO identity of any subtype and NO source. Mirrors TS subtype-rules.ts
# validateValuePurity (effective children; envelope = the offending child).
def _validate_value_purity(node: MetaObject, errors: list[MetaError]) -> None:
    for child in node.children():
        if child.type == TYPE_IDENTITY:
            errors.append(
                MetaError(
                    f"value object '{node.fqn()}' must not have an identity "
                    f"({TYPE_IDENTITY}.{child.sub_type} '{child.name}') — value objects are "
                    f'pure data shapes; use subType: "entity" for records with identity '
                    f"(FR-024, ADR-0028)",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION,
                    envelope=child.source,
                )
            )
        elif child.type == TYPE_SOURCE:
            errors.append(
                MetaError(
                    f"value object '{node.fqn()}' must not have a source "
                    f"({TYPE_SOURCE}.{child.sub_type}) — value objects are not persisted "
                    f'shapes; use subType: "entity" or "projection" for stored objects '
                    f"(FR-024, ADR-0028)",
                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION,
                    envelope=child.source,
                )
            )


# FR-024 projection licensing (ADR-0028): a projection's object-level extends may
# only target another object.projection (ERR_SUBTYPE_RULE_VIOLATION); every OWN
# source must have a read-only @kind (ERR_PROJECTION_SOURCE_WRITABLE); identity is
# optional. Mirrors TS subtype-rules.ts validateProjectionLicensing.
def _validate_projection_licensing(node: MetaObject, errors: list[MetaError]) -> None:
    sup = node.super_data
    if sup is not None and not (
        sup.type == TYPE_OBJECT and sup.sub_type == OBJECT_SUBTYPE_PROJECTION
    ):
        errors.append(
            MetaError(
                f"projection '{node.fqn()}' extends '{sup.fqn()}' which is "
                f"{sup.type}.{sup.sub_type} — a projection may only extend another "
                f"projection (FR-024, ADR-0028)",
                ErrorCode.ERR_SUBTYPE_RULE_VIOLATION,
                envelope=node.source,
            )
        )

    # OWN sources only: an inherited source is validated on the projection that
    # declares it; an inherited source from a non-projection super is unreachable
    # without first tripping the extends rule above.
    for child in node.own_children():
        if child.type != TYPE_SOURCE:
            continue
        kind = child.effective_kind() if isinstance(child, MetaSource) else child.sub_type
        if kind not in SOURCE_READ_ONLY_KINDS:
            errors.append(
                MetaError(
                    f"projection '{node.fqn()}' has a writable source (@kind \"{kind}\") — "
                    f"a projection is a derived read-only representation; its sources must "
                    f"be read-only kinds (view, materializedView, storedProc, tableFunction) "
                    f"(FR-024, ADR-0028)",
                    ErrorCode.ERR_PROJECTION_SOURCE_WRITABLE,
                    envelope=child.source,
                )
            )


def _validate_subtype_rules(
    root: MetaData,
    errors: list[MetaError],
    warnings: list[str],
) -> None:
    for node in _walk(root):
        # FR-024 D2 — identity nodes require an author-chosen name (any nesting:
        # object children AND field-nested identities) so the dotted by-name
        # extends form can address them. A nameless node parses with name == ""
        # (only identity.primary carries a default_name in this port).
        if node.type == TYPE_IDENTITY and node.name == "":
            errors.append(
                MetaError(
                    f"identity.{node.sub_type} has no name — identity nodes require an "
                    f'author-chosen name (e.g. "id") so dotted extends refs can address '
                    f"them (FR-024)",
                    ErrorCode.ERR_IDENTITY_NAME_REQUIRED,
                    envelope=node.source,
                )
            )

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
            _validate_value_purity(node, errors)

        elif node.sub_type == OBJECT_SUBTYPE_PROJECTION:
            _validate_projection_licensing(node, errors)


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
            if field.attrs().get("filterable") is not True:
                continue
            if field.name in covered:
                continue
            if field.attrs().get("db.indexed") is True:
                continue
            warnings.append(
                f'[filterable-without-index] field "{node.name}.{field.name}" has @filterable: true '
                f"but is not part of any identity. Filtering on this field will sequential-scan. "
                f"Add @db.indexed: true to the field (when supported), or remove @filterable: true."
            )


# ---------------------------------------------------------------------------
# Pass: @filterable on a subtype with no operator band (SP-H Unit9)
# ---------------------------------------------------------------------------
# A field marked @filterable: true whose subtype has no op band (e.g.
# field.object) would silently generate a filter with an empty operator set —
# a route that rejects every request. Error early.
# → ERR_FILTERABLE_UNSUPPORTED_SUBTYPE.


def _validate_filterable_has_supported_ops(
    root: MetaData,
    errors: list[MetaError],
) -> None:
    for node in _walk(root):
        if node.type != TYPE_OBJECT or not isinstance(node, MetaObject):
            continue
        for field in node.fields():
            if field.attrs().get("filterable") is not True:
                continue
            if ops_for_subtype(field.sub_type):
                continue
            errors.append(
                MetaError(
                    f'Field "{node.name}.{field.name}" has @filterable: true but its subtype '
                    f'"{field.sub_type}" has no filter-operator band. Remove @filterable, or use a '
                    f"field subtype that supports filtering "
                    f"(string/enum/uuid/number/currency/date/boolean).",
                    ErrorCode.ERR_FILTERABLE_UNSUPPORTED_SUBTYPE,
                    envelope=field.source,
                )
            )


# ---------------------------------------------------------------------------
# Pass: field.object @storage validation
# ---------------------------------------------------------------------------
# Cross-port rules (ADR-0013):
#   1. A field.object ALWAYS requires @objectRef → ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF.
#      A field.object models a typed nested value; without @objectRef it is an
#      oxymoron at the logical layer. Open/untyped JSON uses the physical
#      @dbColumnType: jsonb escape hatch on field.string, NOT a bare object. This
#      rule subsumes the legacy @storage-without-@objectRef check (@storage is only
#      meaningful on a field.object), so missing-@objectRef now always reports this
#      single, clearer error — one error per node (the flattened/array check is
#      skipped when @objectRef is absent).
#   2. @storage="flattened" + isArray → ERR_STORAGE_FLATTENED_ARRAY (flattened
#      materialises one-column-per-field; arrays require @storage="jsonb").


def _validate_field_object_storage(root: MetaData, errors: list[MetaError]) -> None:
    for node in _walk(root):
        if node.type != TYPE_FIELD or node.sub_type != FIELD_SUBTYPE_OBJECT:
            continue
        object_ref = node.attr(FIELD_ATTR_OBJECT_REF)
        if not (isinstance(object_ref, str) and object_ref):
            errors.append(MetaError(
                code=ErrorCode.ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF,
                message=(
                    f"field.object '{node.name}' has no @objectRef — a field.object "
                    f"requires @objectRef. For an open/untyped JSON map use "
                    f"@dbColumnType: jsonb on a field.string instead of a bare object."
                ),
                envelope=node.source,
            ))
            continue
        storage = node.attr(FIELD_ATTR_STORAGE)
        if storage is None:
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
# Pass: field.map value-type validation
#
# A field.map is an open-keyed map (dict[str, V] / Record<string,V>) stored in a
# single jsonb column. Keys are always strings. The value type is set by EXACTLY
# ONE of @valueType (a scalar value subtype) or @objectRef (a value-object). This
# pass enforces that exactly-one-of rule and that @valueType (when set) names a
# known scalar subtype. Cross-port parity: TS validateFieldMap, Java
# validateFieldMap, C# ValidateFieldMap.
# ---------------------------------------------------------------------------

# Scalar value subtypes legal as a field.map @valueType (mirrors the TS
# _MAP_SCALAR_VALUE_SUBTYPES set).
_MAP_SCALAR_VALUE_SUBTYPES = frozenset({
    FIELD_SUBTYPE_STRING,
    FIELD_SUBTYPE_INT,
    FIELD_SUBTYPE_LONG,
    FIELD_SUBTYPE_DOUBLE,
    FIELD_SUBTYPE_FLOAT,
    FIELD_SUBTYPE_DECIMAL,
    FIELD_SUBTYPE_BOOLEAN,
    FIELD_SUBTYPE_DATE,
    FIELD_SUBTYPE_TIME,
    FIELD_SUBTYPE_TIMESTAMP,
    FIELD_SUBTYPE_UUID,
})


def _validate_field_map(root: MetaData, errors: list[MetaError]) -> None:
    for obj in (c for c in root.own_children() if c.type == TYPE_OBJECT):
        for field in (c for c in obj.own_children() if c.type == TYPE_FIELD):
            if field.sub_type != FIELD_SUBTYPE_MAP:
                continue

            value_type = field.attr(FIELD_ATTR_VALUE_TYPE)
            has_value_type = isinstance(value_type, str) and bool(value_type)
            object_ref = field.attr(FIELD_ATTR_OBJECT_REF)
            has_object_ref = isinstance(object_ref, str) and bool(object_ref)

            if has_value_type == has_object_ref:
                which = "both are set" if has_value_type else "neither is set"
                errors.append(MetaError(
                    code=ErrorCode.ERR_BAD_ATTR_VALUE,
                    message=(
                        f'field.map "{obj.name}.{field.name}" must set exactly one of '
                        f"@valueType (a scalar value subtype) or @objectRef (a "
                        f"value-object); {which}"
                    ),
                    envelope=field.source,
                ))
                continue

            if has_value_type and value_type not in _MAP_SCALAR_VALUE_SUBTYPES:
                errors.append(MetaError(
                    code=ErrorCode.ERR_BAD_ATTR_VALUE,
                    message=(
                        f'field.map "{obj.name}.{field.name}" has @valueType '
                        f'"{value_type}" which is not a scalar value subtype '
                        f"(string/int/long/double/float/decimal/boolean/date/time/"
                        f"timestamp/uuid). For a value-object-valued map use @objectRef "
                        f"instead."
                    ),
                    envelope=field.source,
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
    # FR-032 (ADR-0032): @payloadRef is FULLY QUALIFIED after the desugar/sweep
    # (e.g. ``acme::ai::ReviewPayload``). Index each object under its bare name,
    # its fqn() AND its package-folded resolution_key() so the FQN ref resolves.
    # Mirrors TS refMatchesObject / the C# @payloadRef RefMatchesObject.
    objects_by_name: dict[str, MetaData] = {}
    for child in root.own_children():
        if child.type == TYPE_OBJECT:
            objects_by_name.setdefault(child.name, child)
            objects_by_name.setdefault(child.fqn(), child)
            objects_by_name.setdefault(child.resolution_key(), child)

    for tpl in root.own_children():
        if tpl.type != TYPE_TEMPLATE:
            continue
        is_prompt = tpl.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT
        payload_ref = tpl.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
        has_payload_ref = isinstance(payload_ref, str) and payload_ref

        # --- subtype-specific attr on the wrong subtype ---
        # e.g. @maxTokens (prompt-only) on a template.output, or @promptStyle
        # (output-only) on a template.prompt. tpl.attr() reads the node's own
        # attrs (not the @extends super-chain), matching the other checks here.
        for attr_name, allowed_sub in _TEMPLATE_SUBTYPE_ONLY_ATTRS.items():
            if tpl.attr(attr_name) is not None and tpl.sub_type != allowed_sub:
                errors.append(MetaError(
                    code=ErrorCode.ERR_INVALID_TEMPLATE,
                    message=(
                        f'template.{tpl.sub_type} "{tpl.name}" carries @{attr_name}, '
                        f"which is only valid on template.{allowed_sub}"
                    ),
                    envelope=tpl.source,
                ))

        # --- @kind / textRef / email part-ref cross-field rules ---
        # template.output is either a document (@kind absent/"document" -> @textRef
        # required) or an email (@kind="email" -> @subjectRef + @htmlBodyRef required,
        # @textRef unused). template.prompt always requires @textRef. Closed-enum
        # membership of @kind is enforced by allowed_values (ERR_BAD_ATTR_VALUE);
        # here we enforce only conditional ref presence. Mirrors TS/Java.
        if tpl.sub_type == tc.TEMPLATE_SUBTYPE_OUTPUT:
            if tpl.attr(tc.TEMPLATE_ATTR_KIND) == tc.TEMPLATE_KIND_EMAIL:
                if not isinstance(tpl.attr(tc.TEMPLATE_ATTR_SUBJECT_REF), str):
                    errors.append(MetaError(
                        code=ErrorCode.ERR_INVALID_TEMPLATE,
                        message=f'template "{tpl.name}" @kind "email" requires @subjectRef',
                        envelope=tpl.source,
                    ))
                if not isinstance(tpl.attr(tc.TEMPLATE_ATTR_HTML_BODY_REF), str):
                    errors.append(MetaError(
                        code=ErrorCode.ERR_INVALID_TEMPLATE,
                        message=f'template "{tpl.name}" @kind "email" requires @htmlBodyRef',
                        envelope=tpl.source,
                    ))
            else:
                # @kind absent or "document" -> require @textRef so a document is
                # never bodyless. (An out-of-enum @kind is flagged separately by
                # the allowed_values schema check.)
                if not isinstance(tpl.attr(tc.TEMPLATE_ATTR_TEXT_REF), str):
                    errors.append(MetaError(
                        code=ErrorCode.ERR_INVALID_TEMPLATE,
                        message=f'template "{tpl.name}" @kind "document" requires @textRef',
                        envelope=tpl.source,
                    ))
        elif is_prompt:
            # template.prompt always carries a renderable body via @textRef.
            if not isinstance(tpl.attr(tc.TEMPLATE_ATTR_TEXT_REF), str):
                errors.append(MetaError(
                    code=ErrorCode.ERR_INVALID_TEMPLATE,
                    message=f'template "{tpl.name}" requires @textRef',
                    envelope=tpl.source,
                ))

        # @payloadRef required-ness is enforced by the generic required-attr schema
        # check (Check 1) — payloadRef is declared required on the concrete template
        # subtypes. No separate manual emit here (matches TS). If absent, the
        # reference-resolution checks below simply skip.
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
