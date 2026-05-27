"""YAML authoring front-end: text -> desugar -> canonical -> shared tree-builder.

Mirrors the TS reference at server/typescript/packages/metadata/src/core/parser-yaml.ts.

parse_yaml is the YAML peer of parse_document (parser.py). It is the only
front-end that should ever see sugared YAML; downstream code (validators,
serializer, conformance) sees the same canonical-JSON-shaped tree regardless
of authoring format. ADR-0006 D4: canonical JSON is the cross-language
interchange; YAML is a sigil-free authoring front-end.
"""
from __future__ import annotations

import yaml  # type: ignore[import-untyped]  # PyYAML ships no type stubs

from .errors import ErrorCode, MetaError, ParseError
from .parser import ParseResult, parse_document
from .registry import TypeRegistry
from .source.yaml_positions import parse_yaml_with_positions
from .yaml_desugar import desugar


def parse_yaml(text: str, registry: TypeRegistry, source: str) -> ParseResult:
    """Parse a YAML authoring document into a canonical-shaped tree.

    Steps mirror TS parser-yaml.ts:
      1. Strip UTF-8 BOM if present (consistent with parse_document).
      2. parse_yaml_with_positions -> a Python object whose mappings carry
         line/col positions for each key (FR5b). Functionally equivalent to
         ``yaml.safe_load`` for downstream consumers; YamlPositionMap is a
         dict subclass.
      3. desugar(raw, registry) -> canonical-JSON-shaped dict + CollectedErrors
         (positions are preserved across Rules 1, 2, 4, 5).
      4. parse_document(canonical, registry, source) -> ParseResult; the
         parser detects position-tagged dicts and populates
         ``source.yaml_position`` on every node it builds.
      5. Merge desugar errors (each carrying its own stable code, e.g.
         ERR_YAML_COERCION) ahead of parse_document's errors.

    PyYAML failures (YAMLError) are wrapped as ParseError(ERR_MALFORMED_YAML).
    """
    # Strip UTF-8 BOM if present (consistent with the JSON file loader's
    # `encoding="utf-8-sig"` behavior).
    if text.startswith("﻿"):
        text = text[1:]

    try:
        parsed = parse_yaml_with_positions(text)
    except yaml.YAMLError as exc:
        raise ParseError(f"Invalid YAML: {exc}", ErrorCode.ERR_MALFORMED_YAML) from exc

    result = desugar(parsed, registry)

    # If the desugar produced nothing usable, surface that up-front via a
    # MetaError so the loader pipeline still terminates gracefully (parallels
    # parse_document's top-level ERR_TOP_LEVEL_NOT_OBJECT path).
    if not result.canonical:
        first = result.errors[0] if result.errors else None
        message = first.message if first is not None else "empty YAML document"
        code = (
            first.code
            if first is not None and first.code is not None
            else ErrorCode.ERR_MALFORMED_YAML
        )
        parse_result = parse_document({}, registry, source, source_format="yaml")
        parse_result.errors.insert(0, MetaError(message, code, source))
        return parse_result

    # FR5b — pass source_format="yaml" so parse_document emits YamlSource
    # envelopes (format "yaml") on every node and error from this YAML input.
    parsed_result = parse_document(result.canonical, registry, source, source_format="yaml")

    # Merge collected desugar errors ahead of parse_document's own errors.
    desugar_metaerrors = [
        MetaError(
            err.message,
            err.code if err.code is not None else ErrorCode.ERR_MALFORMED_YAML,
            source,
        )
        for err in result.errors
    ]
    parsed_result.errors = desugar_metaerrors + parsed_result.errors
    return parsed_result
