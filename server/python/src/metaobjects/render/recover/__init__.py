"""FR-010 tolerant ``recover`` engine (Tier 2).

A forgiving parser that takes dirty LLM output (fenced / preamble / prose-wrapped /
truncated / trailing-comma JSON, unclosed-tag XML) and recovers it into a typed
``dict``, classifying each field. It NEVER raises — the forgiving tier beyond
FR-006's strict Pydantic parser.

Public entry point: :func:`recover`.
"""
from __future__ import annotations

from metaobjects.render.recover import recover_map
from metaobjects.render.recover.coerce import MALFORMED
from metaobjects.render.recover.json_forgiving_reader import (
    TRUNCATED,
    JsonForgivingReader,
)
from metaobjects.render.recover.normalize import normalize_enum
from metaobjects.render.recover.recover import recover
from metaobjects.render.recover.types import (
    Coercion,
    FieldKind,
    FieldRecovery,
    FieldSpec,
    Format,
    Normalizer,
    OnField,
    RecoverOptions,
    RecoverOutcome,
    RecoverSchema,
    RecoveryReport,
    RecoveryResult,
    Tolerance,
)
from metaobjects.render.recover.xml_forgiving_reader import XmlForgivingReader

__all__ = [
    "MALFORMED",
    "TRUNCATED",
    "Coercion",
    "FieldKind",
    "FieldRecovery",
    "FieldSpec",
    "Format",
    "JsonForgivingReader",
    "Normalizer",
    "OnField",
    "RecoverOptions",
    "RecoverOutcome",
    "RecoverSchema",
    "RecoveryReport",
    "RecoveryResult",
    "Tolerance",
    "XmlForgivingReader",
    "normalize_enum",
    "recover",
    "recover_map",
]
