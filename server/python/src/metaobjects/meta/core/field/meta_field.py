"""MetaField — data_type resolves by subtype (ADR-0002)."""
from __future__ import annotations

from ....datatype import DataType
from ...meta_data import MetaData
from . import field_constants as fc

_FIELD_DATA_TYPE = {
    fc.FIELD_SUBTYPE_STRING: DataType.STRING,
    fc.FIELD_SUBTYPE_INT: DataType.INT,
    fc.FIELD_SUBTYPE_LONG: DataType.LONG,
    fc.FIELD_SUBTYPE_DOUBLE: DataType.DOUBLE,
    fc.FIELD_SUBTYPE_FLOAT: DataType.DOUBLE,
    fc.FIELD_SUBTYPE_BOOLEAN: DataType.BOOLEAN,
    fc.FIELD_SUBTYPE_DATE: DataType.DATE,
    fc.FIELD_SUBTYPE_TIMESTAMP: DataType.DATE,
    fc.FIELD_SUBTYPE_TIME: DataType.DATE,
    fc.FIELD_SUBTYPE_DECIMAL: DataType.DECIMAL,
    fc.FIELD_SUBTYPE_OBJECT: DataType.OBJECT,
    fc.FIELD_SUBTYPE_CURRENCY: DataType.LONG,
    fc.FIELD_SUBTYPE_ENUM: DataType.STRING,
    # R6 Plan 2a — field.uuid is string-backed on the wire; the native uuid.UUID
    # binding is surfaced at codegen time (see codegen/type_map.py).
    fc.FIELD_SUBTYPE_UUID: DataType.STRING,
}


class MetaField(MetaData):
    @property
    def data_type(self) -> DataType:
        return _FIELD_DATA_TYPE.get(self.sub_type, DataType.STRING)

    @property
    def object_ref(self) -> str | None:
        """The ``@objectRef`` target FQN for ``field.object`` fields, else None.

        The value is the package-folded form (e.g. ``com::example::om::Address``)
        — matching a target object's ``resolution_key()``.
        """
        v = self.attr(fc.FIELD_ATTR_OBJECT_REF)
        return str(v) if v is not None else None

    def get_value(self, obj: object, name: str | None = None) -> object:
        """Read this field's value from a backing object.

        Dispatches on backing kind: a dict-backed ``ValueObject`` reads through
        its map; any other object reads the attribute via ``getattr``. *name*
        defaults to this field's own ``name`` (override to read a differently
        keyed slot). Arrays are plain Python lists; nested objects are whatever
        the consumer stored (typically another ValueObject / native instance).
        """
        from ..object.value_object import ValueObject

        key = name if name is not None else self.name
        if isinstance(obj, ValueObject):
            return obj.get(key)
        return getattr(obj, key, None)

    def set_value(
        self, obj: object, value: object, name: str | None = None
    ) -> None:
        """Write *value* into a backing object under *name* (defaults to this
        field's own ``name``).

        ValueObject -> map set; any other object -> ``setattr`` typed property.
        No coercion here. Nested objects / arrays are stored as-given (the
        consumer recurses for nested OBJECT fields: resolve the child via
        ``object_ref`` + ``new_instance`` and ``set_value`` it).
        """
        from ..object.value_object import ValueObject

        key = name if name is not None else self.name
        if isinstance(obj, ValueObject):
            obj.set(key, value)
            return
        setattr(obj, key, value)
