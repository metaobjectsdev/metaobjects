"""FR-010 tolerant ``extract`` engine (Tier 2).

A forgiving parser that takes dirty LLM output (fenced / preamble / prose-wrapped /
truncated / trailing-comma JSON, unclosed-tag XML) and extracts it into a typed
``dict``, classifying each field. It NEVER raises — the forgiving tier beyond
FR-006's strict Pydantic parser.

Public entry point: :func:`extract`.
"""
from __future__ import annotations

from metaobjects.render.extract import extract_map
from metaobjects.render.extract.coerce import MALFORMED, scalar_coerce
from metaobjects.render.extract.json_forgiving_reader import (
    TRUNCATED,
    JsonForgivingReader,
)
from metaobjects.render.extract.normalize import normalize_enum
from metaobjects.render.extract.extract import extract
from metaobjects.render.extract.types import (
    Coercion,
    FieldKind,
    FieldExtraction,
    FieldSpec,
    Format,
    Normalizer,
    OnField,
    ExtractOptions,
    ExtractionOutcome,
    ExtractSchema,
    ExtractionReport,
    ExtractionResult,
    Tolerance,
)
from metaobjects.render.extract.xml_forgiving_reader import XmlForgivingReader

__all__ = [
    "MALFORMED",
    "TRUNCATED",
    "Coercion",
    "FieldKind",
    "FieldExtraction",
    "FieldSpec",
    "Format",
    "JsonForgivingReader",
    "Normalizer",
    "OnField",
    "ExtractOptions",
    "ExtractionOutcome",
    "ExtractSchema",
    "ExtractionReport",
    "ExtractionResult",
    "Tolerance",
    "XmlForgivingReader",
    "normalize_enum",
    "extract",
    "extract_map",
    "scalar_coerce",
]
