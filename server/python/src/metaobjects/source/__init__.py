"""FR5a / ADR-0009 — Loader error envelope + source-on-node.

Cross-port-aligned types: every metaobjects port emits the same envelope shape
so a tool consuming errors from multiple language ports can compare them
byte-identically.

Public surface re-exported here:
    * ErrorSource hierarchy (abstract base + 6 variants).
    * JsonPathBuilder + JsonPath helpers (canonical JSONPath construction).
    * LoaderError / LoaderWarning / NodeContext / Contributor envelope types.
    * semantic_diff(a, b) for FR5c overlay-merge consumption.

See `docs/superpowers/specs/2026-05-25-fr5a-json-shape-loader-errors.md` and
`spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md`.
"""
from __future__ import annotations

from .error_source import (
    CodeSource,
    Contributor,
    DatabaseSource,
    DbLocation,
    ErrorSource,
    JsonSource,
    LoaderError,
    LoaderWarning,
    MergedSource,
    NodeContext,
    ResolvedSource,
    YamlPosition,
    YamlSource,
    resolved_source,
)
from .json_path import JsonPath, JsonPathBuilder
from .semantic_diff import semantic_diff
from .yaml_positions import (
    YamlPositionMap,
    get_position_map,
    get_yaml_position,
    parse_yaml_with_positions,
    set_position_map,
)

__all__ = [
    # ErrorSource hierarchy
    "ErrorSource",
    "JsonSource",
    "YamlSource",
    "MergedSource",
    "ResolvedSource",
    "resolved_source",
    "DatabaseSource",
    "CodeSource",
    # Supporting types
    "Contributor",
    "DbLocation",
    "NodeContext",
    "YamlPosition",
    "LoaderError",
    "LoaderWarning",
    # JSONPath
    "JsonPathBuilder",
    "JsonPath",
    # Semantic diff
    "semantic_diff",
    # FR5b — YAML positions
    "YamlPositionMap",
    "get_position_map",
    "get_yaml_position",
    "set_position_map",
    "parse_yaml_with_positions",
]
