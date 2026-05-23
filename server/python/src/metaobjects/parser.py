"""JSON document -> node tree. Owns inline-vs-child attr syntax (ADR-0002)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast

from .errors import ErrorCode, MetaError
from .meta.meta_data import MetaData
from .meta.meta_root import MetaRoot
from .registry import TypeRegistry
from .shared.base_types import SUBTYPE_ROOT, TYPE_ATTR, TYPE_METADATA
from .shared.separators import ATTR_PREFIX, FUSED_KEY_SEP
from .shared.structural import (
    KEY_ABSTRACT,
    KEY_CHILDREN,
    KEY_EXTENDS,
    KEY_IS_ARRAY,
    KEY_NAME,
    KEY_PACKAGE,
    KEY_VALUE,
)


@dataclass
class ParseResult:
    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def parse_document(doc: object, registry: TypeRegistry, source: str) -> ParseResult:
    result = ParseResult(root=MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, ""))
    if not isinstance(doc, dict):
        result.errors.append(MetaError("top-level is not an object", ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, source))
        return result
    if len(doc) != 1:
        result.errors.append(MetaError("expected one wrapper key", ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, source))
        return result

    (wrapper, body), = cast(list[tuple[str, object]], list(doc.items()))
    node = _build(wrapper, body, registry, source, result)
    if isinstance(node, MetaData):
        result.root = node
    return result


def _build(
    wrapper: str,
    body: object,
    registry: TypeRegistry,
    source: str,
    result: ParseResult,
) -> MetaData | None:
    type_, _, sub_type = wrapper.partition(FUSED_KEY_SEP)
    if not sub_type:
        result.errors.append(MetaError(f"node '{wrapper}' omits subType", ErrorCode.ERR_MISSING_SUBTYPE, source))
        return None
    if not registry.has_type(type_):
        result.errors.append(MetaError(f"unknown type '{type_}'", ErrorCode.ERR_UNKNOWN_TYPE, source))
        return None
    definition = registry.find(type_, sub_type)
    if definition is None:
        result.errors.append(MetaError(f"unknown subType '{type_}.{sub_type}'", ErrorCode.ERR_UNKNOWN_SUBTYPE, source))
        return None

    body_dict: dict[str, object] = body if isinstance(body, dict) else {}
    name = str(body_dict.get(KEY_NAME, "") or "")
    node = definition.factory(type_, sub_type, name)
    assert isinstance(node, MetaData)

    pkg = body_dict.get(KEY_PACKAGE)
    node.package = str(pkg) if pkg else None  # explicit only; inferred package is omitted (Phase 2 computes effective)
    if body_dict.get(KEY_EXTENDS):
        node.super_ref = str(body_dict[KEY_EXTENDS])
    node.is_abstract = bool(body_dict.get(KEY_ABSTRACT, False))
    node.is_array = bool(body_dict.get(KEY_IS_ARRAY, False))

    for key, value in body_dict.items():
        if key.startswith(ATTR_PREFIX):
            attr_name = key[len(ATTR_PREFIX):]
            schema = registry.attr_schema(type_, sub_type, attr_name)
            node.set_attr(attr_name, value, sub_type=schema.value_type if schema else None)

    for cw, cbody in _iter_children(body_dict):
        child_type, _, child_sub = cw.partition(FUSED_KEY_SEP)
        if child_type == TYPE_ATTR:
            _parse_attr_child(node, child_sub, cbody, registry, source, result)
        else:
            child = _build(cw, cbody, registry, source, result)
            if child is not None:
                node.add_child(child)

    return node


def _parse_attr_child(
    parent: MetaData,
    sub_type: str,
    body: object,
    registry: TypeRegistry,
    source: str,
    result: ParseResult,
) -> None:
    """Handle a typed attr child: { "attr.<sub>": { "name": ..., "value": ... } }.

    Attaches via set_attr (not add_child) — attrs are not structural children.
    Uses the child's own sub_type to pick the correct attr class (coerce + desugar).
    """
    body_dict: dict[str, object] = body if isinstance(body, dict) else {}
    attr_name = body_dict.get(KEY_NAME)
    if not isinstance(attr_name, str) or not attr_name:
        result.errors.append(
            MetaError(
                f"attr child requires a non-empty 'name'",
                ErrorCode.ERR_MISSING_REQUIRED_ATTR,
                source,
            )
        )
        return
    raw_value = body_dict.get(KEY_VALUE)
    # Resolve the attr sub_type; fall back to base if unregistered.
    resolved_sub = sub_type if registry.find(TYPE_ATTR, sub_type) is not None else None
    parent.set_attr(attr_name, raw_value, sub_type=resolved_sub)


def _iter_children(body: dict[str, object]) -> list[tuple[str, object]]:
    raw = body.get(KEY_CHILDREN, [])
    out: list[tuple[str, object]] = []
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict) and len(entry) == 1:
                (cw, cbody), = cast(list[tuple[str, object]], list(entry.items()))
                out.append((cw, cbody))
    return out
