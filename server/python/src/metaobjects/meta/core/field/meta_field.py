"""MetaField — data_type resolves by subtype (ADR-0002)."""
from __future__ import annotations

from ....datatype import DataType
from ....shared.base_types import TYPE_ORIGIN
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
    # field.map is the map analog of field.object — an open-keyed map stored as a
    # single jsonb/object column. Same logical data type as field.object.
    fc.FIELD_SUBTYPE_MAP: DataType.OBJECT,
    fc.FIELD_SUBTYPE_CURRENCY: DataType.LONG,
    fc.FIELD_SUBTYPE_ENUM: DataType.STRING,
    # R6 Plan 2a — field.uuid is string-backed on the wire; the native uuid.UUID
    # binding is surfaced at codegen time (see codegen/type_map.py).
    fc.FIELD_SUBTYPE_UUID: DataType.STRING,
    # ADR-0036/0037 Wave 3 — field.uri / field.inet are string-backed on the wire
    # (same as field.uuid); the idiomatic native bindings (urllib.parse / ipaddress)
    # are surfaced at codegen time (see codegen/type_map.py).
    fc.FIELD_SUBTYPE_URI: DataType.STRING,
    fc.FIELD_SUBTYPE_INET: DataType.STRING,
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

        ADR-0039 — RESOLVING (``get_meta_attr``): ``@objectRef`` is an effective
        property, so a concrete ``field.object`` extending an abstract one inherits
        its target. Unifies with the codegen ``attrs().get(@objectRef)`` path (both
        now resolve through the ``extends`` super chain).
        """
        v = self.get_meta_attr(fc.FIELD_ATTR_OBJECT_REF)
        return str(v) if v is not None else None

    def is_derived(self) -> bool:
        """Whether this field is DERIVED — it carries an ``origin.*`` child
        (``passthrough`` / ``aggregate`` / …), so its value is computed from a read
        source (a view join or aggregate), not stored on the writable table.

        Derived ⇒ read-only wherever the field lives (ADR-0028): excluded from the
        write table + create/update inputs, carried only on the read shape (FR-024 §7,
        #214). Mirrors the TS/Java ``MetaField.isDerived()``.

        OWN-only (ADR-0029/0039): an ``origin.*`` never inherits via ``extends``, so
        this reads own children (matched by ``type`` so no ``MetaOrigin`` import is
        needed — the core field module must not depend on the persistence layer)."""
        return any(c.type == TYPE_ORIGIN for c in self.own_children())

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
