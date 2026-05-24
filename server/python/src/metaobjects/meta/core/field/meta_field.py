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
    fc.FIELD_SUBTYPE_DECIMAL: DataType.DOUBLE,
    fc.FIELD_SUBTYPE_OBJECT: DataType.OBJECT,
    fc.FIELD_SUBTYPE_CLASS: DataType.STRING,
    fc.FIELD_SUBTYPE_CURRENCY: DataType.LONG,
    fc.FIELD_SUBTYPE_ENUM: DataType.STRING,
}


class MetaField(MetaData):
    @property
    def data_type(self) -> DataType:
        return _FIELD_DATA_TYPE.get(self.sub_type, DataType.STRING)
