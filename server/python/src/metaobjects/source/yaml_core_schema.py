"""YAML 1.2 core-schema loader.

PyYAML resolves plain scalars as YAML 1.1, where ``off``/``no``/``y`` are
booleans, ``1:30`` is a sexagesimal int, ``0777`` is octal, ``1_000`` is an int
and ``2024-01-02`` is a ``date``. The TypeScript loader uses the ``yaml``
package, which resolves the 1.2 core schema: only ``true``/``false`` are
booleans, only ``[-+]?[0-9]+`` / ``0o`` / ``0x`` are ints, and there is no
timestamp type. This loader gives Python the same scalar resolution, so one
YAML file loads to the same model in every port.
"""
from __future__ import annotations

import math
import re
from typing import Any

import yaml  # type: ignore[import-untyped]  # PyYAML ships no type stubs

_TAG_NULL = "tag:yaml.org,2002:null"
_TAG_BOOL = "tag:yaml.org,2002:bool"
_TAG_INT = "tag:yaml.org,2002:int"
_TAG_FLOAT = "tag:yaml.org,2002:float"

# YAML 1.2 section 10.3.2 (core schema) tag resolution.
_NULL_RE = re.compile(r"^(?:~|null|Null|NULL|)$")
_BOOL_RE = re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$")
_INT_RE = re.compile(r"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$")
_FLOAT_RE = re.compile(
    r"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?"
    r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$"
)


class CoreSchemaLoader(yaml.SafeLoader):  # type: ignore[misc]
    """``SafeLoader`` whose implicit scalar resolvers are the YAML 1.2 core schema."""

    # Own table: ``add_implicit_resolver`` copies the inherited one on first use,
    # so reset it here to drop every 1.1 resolver (timestamp, merge, value, ...).
    yaml_implicit_resolvers: dict[str, list[tuple[str, re.Pattern[str]]]] = {}


CoreSchemaLoader.add_implicit_resolver(_TAG_NULL, _NULL_RE, ["~", "n", "N", ""])
CoreSchemaLoader.add_implicit_resolver(_TAG_BOOL, _BOOL_RE, list("tTfF"))
CoreSchemaLoader.add_implicit_resolver(_TAG_INT, _INT_RE, list("-+0123456789"))
CoreSchemaLoader.add_implicit_resolver(_TAG_FLOAT, _FLOAT_RE, list("-+0123456789."))


def _construct_null(loader: yaml.SafeLoader, node: yaml.Node) -> None:
    loader.construct_scalar(node)
    return None


def _construct_bool(loader: yaml.SafeLoader, node: yaml.Node) -> bool:
    return str(loader.construct_scalar(node)).lower() == "true"


def _construct_int(loader: yaml.SafeLoader, node: yaml.Node) -> int:
    text = str(loader.construct_scalar(node))
    if text.startswith("0o"):
        return int(text[2:], 8)
    if text.startswith("0x"):
        return int(text[2:], 16)
    return int(text, 10)


def _construct_float(loader: yaml.SafeLoader, node: yaml.Node) -> float:
    text = str(loader.construct_scalar(node)).lower()
    if text.endswith(".nan"):
        return math.nan
    if text.endswith(".inf"):
        return -math.inf if text.startswith("-") else math.inf
    return float(text)


CoreSchemaLoader.add_constructor(_TAG_NULL, _construct_null)
CoreSchemaLoader.add_constructor(_TAG_BOOL, _construct_bool)
CoreSchemaLoader.add_constructor(_TAG_INT, _construct_int)
CoreSchemaLoader.add_constructor(_TAG_FLOAT, _construct_float)


def safe_load_core(text: str) -> Any:
    """``yaml.safe_load`` with YAML 1.2 core-schema scalars and unique mapping keys."""
    loader = CoreSchemaLoader(text)
    try:
        node = loader.get_single_node()
        if node is None:
            return None
        _reject_duplicate_keys(node)
        return loader.construct_document(node)
    finally:
        loader.dispose()


def _reject_duplicate_keys(node: yaml.Node) -> None:
    """Raise on a repeated scalar key in any mapping (the ``yaml`` package does too)."""
    seen_nodes: set[int] = set()
    stack = [node]
    while stack:
        current = stack.pop()
        if id(current) in seen_nodes:
            continue
        seen_nodes.add(id(current))
        if isinstance(current, yaml.SequenceNode):
            stack.extend(current.value)
        elif isinstance(current, yaml.MappingNode):
            check_unique_keys(current)
            for key_node, value_node in current.value:
                stack.append(key_node)
                stack.append(value_node)


def check_unique_keys(node: yaml.MappingNode) -> None:
    seen: set[str] = set()
    for key_node, _ in node.value:
        if not isinstance(key_node, yaml.ScalarNode):
            continue
        key = str(key_node.value)
        if key in seen:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate mapping key {key!r}", key_node.start_mark
            )
        seen.add(key)
