"""FR5b — YAML authoring source-position carrier + walker (per ADR-0009).

Mirrors the TS reference split across:
    * server/typescript/packages/metadata/src/core/yaml-positions.ts
      (pure types + Symbol carrier + accessors)
    * server/typescript/packages/metadata/src/core/yaml-positions-walker.ts
      (YAML AST → JS walker that attaches position-by-key maps)

The TS reference splits these for browser-bundle safety (the walker imports
``yaml``, which is Node-only). Python has no such boundary — both layers live
here in one module.

Source-map carrier (the FR5b spec's "open question" §2): TS uses a Symbol-keyed,
non-enumerable property on each mapping object. Python's equivalent is a
``dict`` subclass (:class:`YamlPositionMap`) with a private ``_yaml_positions``
slot. Rationale:

    * ``isinstance(d, dict)`` is still ``True`` — code that walks the parsed
      structure as plain dicts is unaffected.
    * ``json.dumps`` and ``for k in d`` ignore non-key attributes (the
      slot is invisible to standard iteration/serialization, matching the
      "non-enumerable" property of the TS Symbol-keyed prop).
    * No parallel ``id(obj) → positions`` sidecar to keep in sync — the
      position rides with the dict it describes.

On desugar-synthesized nodes (Rule 2's scalar-body lift): the synthesized body
``{ name: rawScalar }`` inherits the wrapper key's position from the parent's
position map. On any other synthesis (Rule 4's isArray stamping, Rule 5's
``@``-prefix rewrite), the position survives because the desugar carries the
position map across the rewrite.
"""
from __future__ import annotations

from typing import Any, Optional

import yaml  # type: ignore[import-untyped]  # PyYAML ships no type stubs

from .error_source import YamlPosition


class YamlPositionMap(dict):
    """A ``dict`` subclass that carries a sidecar position-by-key map.

    The carrier of FR5b YAML positions. Instances of this class behave as
    plain ``dict`` for every consumer that does not know to look (iteration,
    ``in``, ``json.dumps``, ``isinstance`` checks), but expose a private
    ``_yaml_positions`` slot that the loader reads to surface
    :class:`YamlPosition` data on ``node.source``.

    Key (string) → :class:`YamlPosition` (line, col, 1-based).
    """

    __slots__ = ("_yaml_positions",)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._yaml_positions: dict[str, YamlPosition] = {}


def get_position_map(obj: Any) -> Optional[dict[str, YamlPosition]]:
    """Read the position-by-key map from a value, if present.

    Returns ``None`` for primitives, lists, ``None``, and untagged dicts.
    Only :class:`YamlPositionMap` instances carry a map.
    """
    if isinstance(obj, YamlPositionMap):
        return obj._yaml_positions
    return None


def get_yaml_position(obj: Any, key: str) -> Optional[YamlPosition]:
    """Read the position for a specific key on a mapping object.

    Returns ``None`` when the mapping is not a :class:`YamlPositionMap` or
    the key has no recorded position.
    """
    pmap = get_position_map(obj)
    if pmap is None:
        return None
    return pmap.get(key)


def set_position_map(
    obj: YamlPositionMap,
    positions: dict[str, YamlPosition],
) -> None:
    """Attach (or replace) the position-by-key map on a mapping object.

    Mirrors TS ``setPositionMap`` — the map is stored on the dict's private
    slot, invisible to ``for k in d`` / ``json.dumps``.
    """
    obj._yaml_positions = positions


# ---------------------------------------------------------------------------
# Walker — YAML AST → Python dict tree with positions attached
# ---------------------------------------------------------------------------


def parse_yaml_with_positions(text: str) -> Any:
    """Parse YAML text and return a Python structure with positions attached.

    Mirrors the contract of :func:`yaml.safe_load` for the shapes the
    metaobjects authoring grammar uses (mappings, sequences, scalars). Aliases
    are resolved via the underlying SafeLoader pipeline — i.e. they resolve
    as the library normally would.

    Every mapping in the resulting structure is a :class:`YamlPositionMap`
    with a populated ``_yaml_positions`` sidecar; the (1-based) line/col is
    the position of the KEY token in the YAML source.

    Raises:
        :class:`yaml.YAMLError`: on YAML syntax errors (same as
            ``yaml.safe_load``).
    """
    loader = yaml.SafeLoader(text)
    try:
        node = loader.get_single_node()
        if node is None:
            return None
        return _yaml_node_to_py(node, loader)
    finally:
        loader.dispose()


def _yaml_node_to_py(node: Any, loader: Any) -> Any:
    """Walk a yaml AST node into a Python structure.

    For each :class:`yaml.MappingNode`, attach a position-by-key map (via
    :class:`YamlPositionMap`) onto the resulting dict — the position of each
    key is the (line, col) of the KEY token in the YAML source.

    Scalar nodes are constructed via the SafeLoader's constructor pipeline,
    so YAML 1.1's typed scalars (null, bool, int, float) coerce exactly the
    way :func:`yaml.safe_load` produces them. The desugar's D2 coercion
    guard fires on those coerced values, matching TS / Java / C# behavior.
    """
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_object(node, deep=True)
    if isinstance(node, yaml.SequenceNode):
        return [_yaml_node_to_py(item, loader) for item in node.value]
    if isinstance(node, yaml.MappingNode):
        out = YamlPositionMap()
        positions: dict[str, YamlPosition] = {}
        for key_node, value_node in node.value:
            # Only string-keyed entries are valid in metaobjects authoring;
            # ignore exotic keys (numeric / complex) — they would already
            # break the desugar.
            if not isinstance(key_node, yaml.ScalarNode):
                continue
            key_text = str(key_node.value)
            value = _yaml_node_to_py(value_node, loader)
            out[key_text] = value
            # start_mark is 0-indexed; FR5b positions are 1-indexed.
            mark = key_node.start_mark
            if mark is not None:
                positions[key_text] = YamlPosition(
                    line=mark.line + 1, col=mark.column + 1
                )
        if positions:
            set_position_map(out, positions)
        return out
    # Tags / unsupported — fall back to None. The metaobjects authoring
    # grammar does not use them.
    return None


__all__ = [
    "YamlPositionMap",
    "get_position_map",
    "get_yaml_position",
    "set_position_map",
    "parse_yaml_with_positions",
]
