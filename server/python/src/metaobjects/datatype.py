"""Coarse value-type classification shared across nodes."""
from __future__ import annotations

from enum import Enum


class DataType(str, Enum):
    STRING = "string"
    INT = "int"
    LONG = "long"
    DOUBLE = "double"
    # DECIMAL is the exact, Decimal-preserving numeric type (NUMERIC columns).
    # Distinct from DOUBLE so field.decimal surfaces a native ``Decimal`` (lossless),
    # never a lossy float — see ADR-0019 + the SP-D runtime return-type contract.
    DECIMAL = "decimal"
    BOOLEAN = "boolean"
    DATE = "date"
    OBJECT = "object"
    STRING_ARRAY = "stringArray"
