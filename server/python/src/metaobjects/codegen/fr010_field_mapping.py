"""Shared field-kind mapping for the FR-010 codegen emitters (``recover_schema_emitter``
+ ``output_format_spec_emitter``).

Maps a metadata field subtype onto the render engine's ``FieldKind`` member, the
idiomatic ``X | None`` Python type used by the recover mirror dataclass, and the
``recover_map.as_*`` accessor that reads it from the forgiving outcome map.

Mirrors the C# ``Fr010FieldMapping`` and the Java ``RecoverSchemaEmitter`` ordering.
Bounded scope (parity with Java / Kotlin / C#): scalar / enum / scalar-array. Nested
object + array-of-enum are deferred (see ``render/recover/KNOWN_GAPS.md``).

Python has a single ``int`` type, so the ``LONG`` and ``CURRENCY`` subtypes map to the
``LONG`` ``FieldKind`` (and ``recover_map.as_long`` — identical to ``as_int``), keeping
the cross-port ``FieldKind`` vocabulary intact even though the emitted accessor is the
same. The mirror annotation collapses ``INT``/``LONG`` to ``int`` (one numeric int type).
"""
from __future__ import annotations

from collections.abc import Iterable

from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.base_types import TYPE_FIELD
from metaobjects.shared.structural import KEY_IS_ARRAY


def fields(vo: MetaData) -> list[MetaData]:
    """The field children of a payload value-object, in declaration order
    (effective children — own + inherited via ``extends``)."""
    return [c for c in vo.children() if c.type == TYPE_FIELD]


def is_array(field: MetaData) -> bool:
    """Array-ness from either form: the node property (programmatic build) or the
    ``@isArray`` attr (how metadata loads from JSON)."""
    return bool(field.is_array) or field.attr(KEY_IS_ARRAY) is True


def is_required(field: MetaData) -> bool:
    """``@required`` — accepts a bool ``True`` or the string ``"true"``."""
    v = field.attr(fc.FIELD_ATTR_REQUIRED)
    if v is True:
        return True
    return isinstance(v, str) and v.lower() == "true"


def enum_values(field: MetaData) -> list[str]:
    """The string members of an enum field's ``@values`` attr (empty when absent)."""
    v = field.attr(fc.FIELD_ATTR_VALUES)
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return []


def _own_attr_string(node: MetaData, name: str) -> str | None:
    """The own (locally declared) string value of attr *name*, or ``None``."""
    v = node.attr(name)
    return v if isinstance(v, str) else None


def coerce_default(field: MetaData) -> str | None:
    """FR-011: the enum field's own ``@coerceDefault`` member, or ``None``."""
    return _own_attr_string(field, fc.FIELD_ATTR_COERCE_DEFAULT)


def default_value(field: MetaData) -> str | None:
    """FR-011: the enum field's own ``@default`` absent-fill member, or ``None``."""
    return _own_attr_string(field, fc.FIELD_ATTR_DEFAULT)


def resolve_normalize(field: MetaData, owner: MetaData | None) -> str:
    """FR-011: resolve the enum normalization mode — field-level ``@normalize``, else the
    owning ``object.value``'s ``@normalize`` (the per-object default), else the global
    default (``"strip"``). Mirrors the Java/Kotlin/C#/TS ``resolveNormalize``."""
    field_mode = _own_attr_string(field, fc.FIELD_ATTR_NORMALIZE)
    if field_mode is not None:
        return field_mode
    if owner is not None:
        owner_mode = _own_attr_string(owner, fc.FIELD_ATTR_NORMALIZE)
        if owner_mode is not None:
            return owner_mode
    return fc.NORMALIZE_DEFAULT


def scalar_kind(sub_type: str) -> str | None:
    """The render-engine ``FieldKind`` member name for a scalar field subtype, or
    ``None`` if the subtype is non-scalar (enum / object)."""
    if sub_type in (
        fc.FIELD_SUBTYPE_STRING,
        fc.FIELD_SUBTYPE_CLASS,
        fc.FIELD_SUBTYPE_DATE,
        fc.FIELD_SUBTYPE_TIME,
        fc.FIELD_SUBTYPE_TIMESTAMP,
    ):
        return "STRING"
    if sub_type == fc.FIELD_SUBTYPE_INT:
        return "INT"
    if sub_type in (fc.FIELD_SUBTYPE_LONG, fc.FIELD_SUBTYPE_CURRENCY):
        return "LONG"
    if sub_type in (
        fc.FIELD_SUBTYPE_DOUBLE,
        fc.FIELD_SUBTYPE_FLOAT,
        fc.FIELD_SUBTYPE_DECIMAL,
    ):
        return "DOUBLE"
    if sub_type == fc.FIELD_SUBTYPE_BOOLEAN:
        return "BOOLEAN"
    return None


def mirror_type(field: MetaData) -> str:
    """The ``X | None`` Python annotation for a field in the recover mirror dataclass.

    A recovered array can contain null elements where individual items were lost, so
    the array type is ``list[str | None] | None`` (matches ``recover_map.as_string_list``).
    """
    # Nested object (single OR array): the self-contained path defers to a typed null;
    # the runtime-delegating path overrides this with the nested mirror type. Checked
    # BEFORE the generic is_array branch so an array-of-objects is NOT mistyped as a
    # string array. Mirrors the Java/TS fix.
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        return "object | None"  # nested deferred (self-contained path)
    if is_array(field):
        return "list[str | None] | None"
    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        return "str | None"  # enum is string-backed
    kind = scalar_kind(field.sub_type)
    if kind in ("INT", "LONG"):
        return "int | None"
    if kind == "DOUBLE":
        return "float | None"
    if kind == "BOOLEAN":
        return "bool | None"
    return "str | None"


def recover_map_helper(field: MetaData) -> str | None:
    """The ``recover_map`` accessor a field reads through, or ``None``
    (object/deferred fields read no helper).

    Single source of the field → accessor decision; ``recover_map_call`` builds
    the ``as_*(d, "name")`` call on top of this."""
    # Nested object (single OR array) → no helper in the self-contained path. Checked
    # BEFORE is_array so an array-of-objects is NOT read via as_string_list. Mirrors the
    # Java/TS fix.
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        return None
    if is_array(field):
        return "as_string_list"
    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        return "as_string"
    return {
        "INT": "as_int",
        "LONG": "as_long",
        "DOUBLE": "as_double",
        "BOOLEAN": "as_bool",
    }.get(scalar_kind(field.sub_type) or "", "as_string")


def recover_map_call(field: MetaData) -> str:
    """The ``as_*(d, "name")`` call that reads this field from the forgiving map ``d``.

    The helpers are imported by name into the generated module (see
    ``recover_schema_emitter.recover_map_imports``)."""
    helper = recover_map_helper(field)
    if helper is None:
        # Nested object: the self-contained initializer leaves it None (the
        # runtime-delegating path populates it). Bare ``None`` — no trailing inline
        # comment: this expr is joined into a ``Name(field=..., …)`` call-args list.
        return "None"
    return f'{helper}(d, "{field.name}")'


def py_string_literal(value: str) -> str:
    """A safe Python double-quoted string literal for embedding free text
    (``@example`` / ``@instruction`` / ``@enumDoc`` values) into emitted source.

    Uses ``json.dumps`` — a JSON string is a valid Python string literal and escapes
    backslashes / quotes / control chars correctly (NOT naive quoting)."""
    import json

    return json.dumps(value, ensure_ascii=False)


def string_list_literal(values: Iterable[str]) -> str:
    """A Python ``["a", "b"]`` list literal for enum members."""
    return "[" + ", ".join(py_string_literal(v) for v in values) + "]"


def properties_map_literal(attr: object) -> str:
    """A Python ``{"k": "v", …}`` dict literal for a properties-shaped attr
    (``@enumAlias`` / ``@enumDoc``), or ``"None"`` when absent/empty.

    Null values are dropped; keys are sorted to match the canonical-serializer
    properties sort (deterministic output)."""
    if not isinstance(attr, dict):
        return "None"
    entries = [
        (k, v)
        for k, v in attr.items()
        if v is not None
    ]
    if not entries:
        return "None"
    entries.sort(key=lambda kv: str(kv[0]))
    parts = [
        f"{py_string_literal(str(k))}: {py_string_literal(str(v))}"
        for k, v in entries
    ]
    return "{" + ", ".join(parts) + "}"
