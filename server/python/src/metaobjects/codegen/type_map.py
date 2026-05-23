"""Field-subtype → Python/Pydantic type mapping (sub-project A)."""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.shared.structural import KEY_IS_ARRAY


@dataclass(frozen=True)
class PyType:
    expr: str                          # the annotation text, e.g. "str", "list[PostBrief]"
    imports: tuple[str, ...] = ()      # stdlib import lines this type needs


_SCALAR: dict[str, PyType] = {
    fc.FIELD_SUBTYPE_STRING: PyType("str"),
    fc.FIELD_SUBTYPE_INT: PyType("int"),
    fc.FIELD_SUBTYPE_LONG: PyType("int"),
    fc.FIELD_SUBTYPE_DOUBLE: PyType("float"),
    fc.FIELD_SUBTYPE_FLOAT: PyType("float"),
    fc.FIELD_SUBTYPE_BOOLEAN: PyType("bool"),
    fc.FIELD_SUBTYPE_DECIMAL: PyType("Decimal", ("from decimal import Decimal",)),
    fc.FIELD_SUBTYPE_CURRENCY: PyType("int"),  # integer minor units — wire contract
    fc.FIELD_SUBTYPE_DATE: PyType("datetime.date", ("import datetime",)),
    fc.FIELD_SUBTYPE_TIME: PyType("datetime.time", ("import datetime",)),
    fc.FIELD_SUBTYPE_TIMESTAMP: PyType("datetime.datetime", ("import datetime",)),
    fc.FIELD_SUBTYPE_CLASS: PyType("str"),  # fallback
}


def field_is_array(field: MetaField) -> bool:
    """Array-ness from either form: the node property (programmatic build) or the
    `@isArray` attr (how metadata loads from JSON — the conformance-fixture form)."""
    return field.is_array or field.attr(KEY_IS_ARRAY) is True


def py_type_for(field: MetaField) -> PyType:
    """The (non-optional) Python annotation for a field, wrapping arrays in list[...]."""
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        ref = field.attr(fc.FIELD_ATTR_OBJECT_REF)
        base = PyType(str(ref)) if ref else PyType("object")
    else:
        base = _SCALAR.get(field.sub_type, PyType("str"))
    if field_is_array(field):
        return PyType(f"list[{base.expr}]", base.imports)
    return base
