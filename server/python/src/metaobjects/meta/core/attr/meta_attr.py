"""MetaAttr base + value-shaped subclasses. Value behavior lives here (ADR-0002)."""
from __future__ import annotations

from ....attr_class_map import register_attr_class, register_fallback_attr_class
from ....datatype import DataType
from ...meta_data import MetaData
from ....shared.base_types import SUBTYPE_BASE
from .attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_CLASS,
    ATTR_SUBTYPE_DOUBLE,
    ATTR_SUBTYPE_FILTER,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_LONG,
    ATTR_SUBTYPE_PROPERTIES,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)

_SCALAR_DATA_TYPE = {
    ATTR_SUBTYPE_STRING: DataType.STRING,
    ATTR_SUBTYPE_INT: DataType.INT,
    ATTR_SUBTYPE_LONG: DataType.LONG,
    ATTR_SUBTYPE_DOUBLE: DataType.DOUBLE,
    ATTR_SUBTYPE_BOOLEAN: DataType.BOOLEAN,
}


class MetaAttr(MetaData):
    def __init__(self, type_: str, sub_type: str, name: str) -> None:
        super().__init__(type_, sub_type, name)
        self.value: object = None

    @property
    def data_type(self) -> DataType:
        return _SCALAR_DATA_TYPE.get(self.sub_type, DataType.STRING)

    def coerce(self, raw: object) -> object:
        """Base coercion mirrors TS convertToDataType (data-converter.ts):
        directional toward the declared DataType.

        SUBTYPE_BASE is the polymorphic/unconstrained marker (an undeclared
        @-attr or an attr.base child node): the value is preserved as-is and
        never stringified. Only attrs whose owner declared `value_type=string`
        (i.e. the registry mapped them to ATTR_SUBTYPE_STRING) are coerced.
        This keeps cross-language parity with TS: YAML 1.2 scalar coercion is
        reported once by the desugar's D2 guard (ERR_YAML_COERCION) and the
        downstream attr-schema validator does NOT double-report the same
        offence (since the stored value already matches the declared type).
        """
        if self.sub_type == SUBTYPE_BASE:
            return raw  # polymorphic / unconstrained — type-preserve
        if self.sub_type == ATTR_SUBTYPE_STRING:
            if raw is None or isinstance(raw, str):
                return raw
            if isinstance(raw, bool):
                # bool must NOT be Pythonically rendered as "True"/"False" —
                # use the JSON lower-cased form for cross-language byte parity.
                return "true" if raw else "false"
            if isinstance(raw, (int, float)):
                return str(raw)
            return raw
        return raw

    def desugar(self, value: object) -> object:
        return value

    def set_value(self, raw: object) -> None:
        self._require_mutable()
        self.value = self.desugar(self.coerce(raw))


class StringArrayAttr(MetaAttr):
    @property
    def data_type(self) -> DataType:
        return DataType.STRING_ARRAY

    def coerce(self, raw: object) -> object:
        if isinstance(raw, list):
            return [str(el) for el in raw]
        if isinstance(raw, str):
            return [raw]  # degenerate scalar form -> single-element list
        return raw


_FILTER_OPS = frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "like", "isNull"})


def _is_op_object(value: object) -> bool:
    """Return True if value is already a filter op-object (all keys are filter ops)."""
    return (
        isinstance(value, dict)
        and len(value) > 0
        and all(k in _FILTER_OPS for k in value)
    )


def _desugar_filter_value(value: object) -> object:
    """Desugar a single field-level filter shorthand into an op-object."""
    if value is None:
        return {"isNull": True}
    if isinstance(value, list):
        return {"in": value}
    if _is_op_object(value):
        return value  # already an op-object — pass through unchanged
    return {"eq": value}


class FilterAttr(MetaAttr):
    @property
    def data_type(self) -> DataType:
        return DataType.OBJECT

    def desugar(self, value: object) -> object:
        if not isinstance(value, dict):
            return value
        return {field: _desugar_filter_value(v) for field, v in value.items()}


class PropertiesAttr(MetaAttr):
    @property
    def data_type(self) -> DataType:
        return DataType.OBJECT


class ClassAttr(MetaAttr):
    @property
    def data_type(self) -> DataType:
        return DataType.STRING


register_fallback_attr_class(MetaAttr)
register_attr_class(ATTR_SUBTYPE_STRINGARRAY, StringArrayAttr)
register_attr_class(ATTR_SUBTYPE_FILTER, FilterAttr)
register_attr_class(ATTR_SUBTYPE_PROPERTIES, PropertiesAttr)
register_attr_class(ATTR_SUBTYPE_CLASS, ClassAttr)
