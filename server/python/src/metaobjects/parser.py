"""JSON document -> node tree. Owns inline-vs-child attr syntax (ADR-0002)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast

from .errors import ErrorCode, MetaError
from .meta.meta_data import MetaData
from .meta.meta_root import MetaRoot
from .registry import TypeRegistry
from .shared.base_types import SUBTYPE_ROOT, TYPE_ATTR, TYPE_FIELD, TYPE_METADATA, TYPE_OBJECT
from .shared.separators import ATTR_PREFIX, FUSED_KEY_SEP
from .shared.structural import (
    KEY_ABSTRACT,
    KEY_CHILDREN,
    KEY_EXTENDS,
    KEY_IS_ARRAY,
    KEY_NAME,
    KEY_OVERLAY,
    KEY_PACKAGE,
    KEY_VALUE,
)
from .source import CodeSource, ErrorSource, JsonPathBuilder, JsonSource

# Reserved structural body keys — authoring any of these with the @-prefix is a
# hard ERR_RESERVED_ATTR (ADR-0007). Detected inline as each @-key is processed.
_RESERVED_STRUCTURAL_KEYS: frozenset[str] = frozenset({
    KEY_NAME,
    KEY_PACKAGE,
    KEY_EXTENDS,
    KEY_ABSTRACT,
    KEY_OVERLAY,
    KEY_IS_ARRAY,
    KEY_CHILDREN,
    KEY_VALUE,
})


@dataclass
class ParseResult:
    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _current_envelope(source: str | None, builder: JsonPathBuilder) -> ErrorSource:
    """Build a JsonSource envelope for the current parser location.

    Returns :class:`CodeSource` when *source* is missing (parser invoked
    without a source id — emitting a JsonSource with an empty file list
    would violate the FR5a length-1 invariant). Mirrors the C# fallback in
    ``Parser.ParseState.CurrentSource``.
    """
    if source is None or source == "":
        return CodeSource.DEFAULT
    return JsonSource(files=(source,), json_path=builder.to_string())


def parse_document(doc: object, registry: TypeRegistry, source: str) -> ParseResult:
    builder = JsonPathBuilder()
    result = ParseResult(root=MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, ""))
    if not isinstance(doc, dict):
        result.errors.append(MetaError(
            "top-level is not an object",
            ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT,
            source,
            envelope=_current_envelope(source, builder),
        ))
        return result
    if len(doc) != 1:
        result.errors.append(MetaError(
            "expected one wrapper key",
            ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT,
            source,
            envelope=_current_envelope(source, builder),
        ))
        return result

    (wrapper, body), = cast(list[tuple[str, object]], list(doc.items()))
    builder.push_key(wrapper)
    node = _build(wrapper, body, registry, source, result, builder)
    builder.pop()
    if isinstance(node, MetaData):
        result.root = node
    return result


def _build(
    wrapper: str,
    body: object,
    registry: TypeRegistry,
    source: str,
    result: ParseResult,
    builder: JsonPathBuilder,
    ctx_pkg: str = "",
    parent_type: str = "",
) -> MetaData | None:
    """Build a node from a fused-key wrapper and its body dict.

    *ctx_pkg* is the effective package inherited from the nearest ancestor that
    declared one.  *parent_type* is the type of the immediate parent node (used
    for the field-package-inheritance rule: fields NOT inside objects inherit the
    context package, mirroring the TS/Java loader behaviour for abstract fields
    declared at the root level).
    """
    type_, _, sub_type = wrapper.partition(FUSED_KEY_SEP)
    if not sub_type:
        result.errors.append(MetaError(
            f"node '{wrapper}' omits subType",
            ErrorCode.ERR_MISSING_SUBTYPE,
            source,
            envelope=_current_envelope(source, builder),
        ))
        return None
    if not registry.has_type(type_):
        result.errors.append(MetaError(
            f"unknown type '{type_}'",
            ErrorCode.ERR_UNKNOWN_TYPE,
            source,
            envelope=_current_envelope(source, builder),
        ))
        return None
    definition = registry.find(type_, sub_type)
    if definition is None:
        result.errors.append(MetaError(
            f"unknown subType '{type_}.{sub_type}'",
            ErrorCode.ERR_UNKNOWN_SUBTYPE,
            source,
            envelope=_current_envelope(source, builder),
        ))
        return None

    body_dict: dict[str, object] = body if isinstance(body, dict) else {}
    name = str(body_dict.get(KEY_NAME, "") or "")
    node = definition.factory(type_, sub_type, name)
    assert isinstance(node, MetaData)
    # FR5a / ADR-0009 — every parser-constructed node carries its origin.
    node.set_source(_current_envelope(source, builder))

    pkg = body_dict.get(KEY_PACKAGE)
    if pkg:
        node.package = str(pkg)
    elif type_ == TYPE_FIELD and parent_type != TYPE_OBJECT and ctx_pkg:
        # Fields NOT inside objects inherit the context package.
        # This covers abstract fields declared at root level (e.g. abstract field.enum).
        # Mirrors TS parser-core.ts and Java BaseMetaDataParser.shouldInheritPackageFromParent.
        node.package = ctx_pkg
    else:
        node.package = None

    if body_dict.get(KEY_EXTENDS):
        node.super_ref = str(body_dict[KEY_EXTENDS])
    node.is_abstract = bool(body_dict.get(KEY_ABSTRACT, False))
    node.is_overlay = bool(body_dict.get(KEY_OVERLAY, False))
    node.is_array = bool(body_dict.get(KEY_IS_ARRAY, False))

    for key, value in body_dict.items():
        if key.startswith(ATTR_PREFIX):
            attr_name = key[len(ATTR_PREFIX):]
            # ADR-0007: @-prefixing a reserved structural body key is invalid.
            # Detected inline as each @-attr key is processed (matches TS parser-core).
            if attr_name in _RESERVED_STRUCTURAL_KEYS:
                builder.push_key(key)
                result.errors.append(
                    MetaError(
                        f"node '{wrapper}' uses reserved structural key '{attr_name}' "
                        f"with @-prefix; bare '{attr_name}' is the canonical form",
                        ErrorCode.ERR_RESERVED_ATTR,
                        source,
                        envelope=_current_envelope(source, builder),
                    )
                )
                builder.pop()
                continue
            schema = registry.attr_schema(type_, sub_type, attr_name)
            node.set_attr(attr_name, value, sub_type=schema.value_type if schema else None)
            # FR5a / ADR-0009 — stamp the just-constructed MetaAttribute node with
            # its origin envelope. Mirrors C# Parser.cs:1039 (attrModel.SetSource).
            # The attr's JsonPath points at the @-key on the parent body.
            attr_node = node.own_meta_attr(attr_name)
            if attr_node is not None:
                builder.push_key(key)
                attr_node.set_source(_current_envelope(source, builder))
                builder.pop()

    # The context package for children: use this node's own package if set, else inherit.
    child_ctx_pkg = node.package or ctx_pkg

    # Descend into children: push `children` key, then `[i]` index for each entry,
    # then the child wrapper key, so JsonPath segments stack correctly.
    children_entries = _iter_children(body_dict)
    if children_entries:
        builder.push_key(KEY_CHILDREN)
        for idx, (cw, cbody) in enumerate(children_entries):
            builder.push_index(idx)
            builder.push_key(cw)
            child_type, _, child_sub = cw.partition(FUSED_KEY_SEP)
            if child_type == TYPE_ATTR:
                _parse_attr_child(node, child_sub, cbody, registry, source, result, builder)
            else:
                child = _build(
                    cw, cbody, registry, source, result, builder,
                    ctx_pkg=child_ctx_pkg, parent_type=type_,
                )
                if child is not None:
                    node.add_child(child)
            builder.pop()
            builder.pop()
        builder.pop()

    return node


def _parse_attr_child(
    parent: MetaData,
    sub_type: str,
    body: object,
    registry: TypeRegistry,
    source: str,
    result: ParseResult,
    builder: JsonPathBuilder,
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
                envelope=_current_envelope(source, builder),
            )
        )
        return
    raw_value = body_dict.get(KEY_VALUE)
    # Resolve the attr sub_type; fall back to base if unregistered.
    resolved_sub = sub_type if registry.find(TYPE_ATTR, sub_type) is not None else None
    parent.set_attr(attr_name, raw_value, sub_type=resolved_sub)
    # FR5a / ADR-0009 — stamp the just-constructed MetaAttribute node with its
    # origin envelope. Mirrors C# Parser.cs:1039 (attrModel.SetSource). The
    # builder already points at the `attr.<sub>` wrapper (caller pushed it).
    attr_node = parent.own_meta_attr(attr_name)
    if attr_node is not None:
        attr_node.set_source(_current_envelope(source, builder))


def _iter_children(body: dict[str, object]) -> list[tuple[str, object]]:
    raw = body.get(KEY_CHILDREN, [])
    out: list[tuple[str, object]] = []
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict) and len(entry) == 1:
                (cw, cbody), = cast(list[tuple[str, object]], list(entry.items()))
                out.append((cw, cbody))
    return out
