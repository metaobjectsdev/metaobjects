"""Loader validation passes — run after super-resolution, before freeze (ADR-0002).

Errors are cross-node checks that cannot live on a single node. Each pass
appends to `errors` (list[MetaError]) or `warnings` (list[str]).
Error message text is free; error CODES are the conformance contract.
Warning strings are byte-identical to the expected-warnings fixtures.
"""
from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.core.object.meta_object import MetaObject
from ..meta.meta_data import MetaData
from ..registry import AttrSchema, TypeRegistry
from ..shared.base_types import TYPE_LAYOUT, TYPE_OBJECT
from ..meta.presentation.layout.layout_constants import (
    LAYOUT_ATTR_DEFAULT_SORT_FIELD,
    LAYOUT_SUBTYPE_DATA_GRID,
)

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
    _validate_datagrid_sort_fields(root, errors)


# ---------------------------------------------------------------------------
# Walk helper
# ---------------------------------------------------------------------------


def _walk(root: MetaData) -> list[MetaData]:
    """Return all nodes in the tree (BFS order, including root)."""
    result: list[MetaData] = []
    queue: list[MetaData] = [root]
    while queue:
        node = queue.pop(0)
        result.append(node)
        queue.extend(node.children())
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
    if value_type == "filter":
        # A legacy-string @filter (not desugared to a dict) is invalid.
        # FilterAttr.desugar only applies when the input IS a dict; if a string
        # was passed with a non-filter subtype, the stored value remains a str.
        return isinstance(value, dict)
    # Unknown value types (e.g. "class", "properties") — allow anything.
    return True


def _node_label(node: MetaData) -> str:
    head = f"{node.type}.{node.sub_type}"
    return f"{head} '{node.name}'" if node.name else head


def _validate_attr_schema(
    root: MetaData,
    registry: TypeRegistry,
    errors: list[MetaError],
) -> None:
    for node in _walk(root):
        schemas: list[AttrSchema] = registry.effective_attrs(node.type, node.sub_type)
        if not schemas:
            continue

        schema_by_name: dict[str, AttrSchema] = {s.name: s for s in schemas}

        # --- Check 1: required attrs must be present (effective = own + inherited) ---
        for schema in schemas:
            if not schema.required:
                continue
            # node.attr() returns None when the attr is absent (own or inherited).
            if node.attr(schema.name) is None:
                errors.append(
                    MetaError(
                        f"{_node_label(node)} is missing required attribute '@{schema.name}'",
                        ErrorCode.ERR_MISSING_REQUIRED_ATTR,
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
                    )
                )
