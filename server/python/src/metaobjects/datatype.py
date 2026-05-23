"""Coarse value-type classification shared across nodes."""
from __future__ import annotations

from enum import Enum


class DataType(str, Enum):
    STRING = "string"
    INT = "int"
    LONG = "long"
    DOUBLE = "double"
    BOOLEAN = "boolean"
    DATE = "date"
    OBJECT = "object"
    STRING_ARRAY = "stringArray"
