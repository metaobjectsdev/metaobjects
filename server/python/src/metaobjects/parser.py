"""JSON document -> node tree. Owns inline-vs-child attr syntax (ADR-0002)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast

from .errors import ErrorCode, MetaError
from .meta.core.attr.attr_constants import ATTR_SUBTYPE_STRINGARRAY
from .meta.meta_data import MetaData
from .meta.meta_root import MetaRoot
from .naming_refs import REF_BEARING_ATTR_NAMES, is_relative_ref
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
from .source import (
    CodeSource,
    ErrorSource,
    JsonPathBuilder,
    JsonSource,
    LoaderWarning,
    YamlPosition,
    YamlSource,
)
from .source.yaml_positions import get_yaml_position

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


# FR-032 (ADR-0032) — canonical-JSON ref guard. Canonical JSON is the
# self-contained interchange form: every ref-bearing attr MUST be fully-qualified.
# A relative authoring form (leading ``::`` or ``..::``) surviving into canonical
# JSON is ``ERR_RELATIVE_REF_IN_CANONICAL`` — relative forms are YAML-authoring
# sugar the desugar expands before canonical JSON. This parser only handles
# canonical JSON (the desugar runs upstream for YAML), so no format check is
# needed. Like ERR_RESERVED_ATTR, this is a hard error; we append it and halt the
# node build so exactly one error is produced. Mirrors the TS/Java/C# guard.
def _guard_relative_ref_in_canonical(
    ref_label: str,
    raw_value: object,
    wrapper: str,
    source: str,
    result: "ParseResult",
    envelope: ErrorSource,
) -> bool:
    """Append ``ERR_RELATIVE_REF_IN_CANONICAL`` when *raw_value* is a relative
    reference string. Returns True when the guard fired (caller halts).
    """
    if not isinstance(raw_value, str) or not is_relative_ref(raw_value):
        return False
    result.errors.append(MetaError(
        f"node '{wrapper}' has relative reference '{raw_value}' on {ref_label}; "
        f"canonical JSON must be fully-qualified — relative forms (leading '::' "
        f"or '..::') are YAML-authoring sugar the desugar expands",
        ErrorCode.ERR_RELATIVE_REF_IN_CANONICAL,
        source,
        envelope=envelope,
    ))
    return True


@dataclass
class ParseResult:
    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # FR5c — envelope-shaped warnings (e.g. WARN_DUPLICATE_DECLARATION)
    # produced during parse. Distinct from the legacy ``warnings: list[str]``
    # channel: those get wrapped in a ``WARN_LEGACY`` envelope at the loader
    # boundary, while envelope warnings already carry their own ``code`` +
    # ``source`` and surface unchanged. Empty by default.
    envelope_warnings: list[LoaderWarning] = field(default_factory=list)


# FR5b — module-level source-format discriminant. Set at the top of
# :func:`parse_document` and read by :func:`_current_envelope`. Safe because
# parse_document is fully synchronous — no reentrancy within a single parse
# call. Mirrors TS's ``_currentFormat`` module-level state in parser-core.ts.
_current_source_format: str = "json"


def _current_envelope(
    source: str | None,
    builder: JsonPathBuilder,
    yaml_position: YamlPosition | None = None,
) -> ErrorSource:
    """Build a source envelope for the current parser location.

    Returns :class:`CodeSource` when *source* is missing (parser invoked
    without a source id — emitting a JsonSource with an empty file list
    would violate the FR5a length-1 invariant). Mirrors the C# fallback in
    ``Parser.ParseState.CurrentSource``.

    FR5b finalized 2026-05-27 — when the module-level
    :data:`_current_source_format` is ``"yaml"`` (set by :func:`parse_document`'s
    ``source_format`` kwarg, supplied by :func:`parse_yaml`), emits a
    :class:`YamlSource` (format ``"yaml"``) carrying the optional
    *yaml_position*. Otherwise emits a :class:`JsonSource`.
    """
    if source is None or source == "":
        return CodeSource.DEFAULT
    if _current_source_format == "yaml":
        return YamlSource(
            files=(source,),
            json_path=builder.to_string(),
            yaml_position=yaml_position,
        )
    return JsonSource(
        files=(source,),
        json_path=builder.to_string(),
        yaml_position=yaml_position,
    )


def parse_document(
    doc: object,
    registry: TypeRegistry,
    source: str,
    *,
    source_format: str = "json",
) -> ParseResult:
    # FR5b — set the module-level source-format discriminant for the duration
    # of this parse call. parse_yaml passes source_format="yaml" so every
    # envelope emitted during this run is a YamlSource (format "yaml").
    global _current_source_format
    prior_format = _current_source_format
    _current_source_format = source_format
    try:
        return _parse_document_inner(doc, registry, source)
    finally:
        _current_source_format = prior_format


def _parse_document_inner(doc: object, registry: TypeRegistry, source: str) -> ParseResult:
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
    # FR5b — look up the root wrapper's YAML position (when the input was
    # YAML-loaded). For JSON input, this returns None and the envelope
    # remains a plain JsonSource with no yaml_position.
    root_yaml_position = get_yaml_position(doc, wrapper)
    node = _build(
        wrapper, body, registry, source, result, builder,
        yaml_position=root_yaml_position,
    )
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
    yaml_position: YamlPosition | None = None,
) -> MetaData | None:
    """Build a node from a fused-key wrapper and its body dict.

    *ctx_pkg* is the effective package inherited from the nearest ancestor that
    declared one.  *parent_type* is the type of the immediate parent node (used
    for the field-package-inheritance rule: fields NOT inside objects inherit the
    context package, mirroring the TS/Java loader behaviour for abstract fields
    declared at the root level).

    *yaml_position* is the FR5b YAML line/col of the wrapper key (if the input
    was YAML-loaded); ``None`` for JSON input. Stamped onto the constructed
    node's source envelope.
    """
    type_, _, sub_type = wrapper.partition(FUSED_KEY_SEP)
    if not sub_type:
        result.errors.append(MetaError(
            f"node '{wrapper}' omits subType",
            ErrorCode.ERR_MISSING_SUBTYPE,
            source,
            envelope=_current_envelope(source, builder, yaml_position),
        ))
        return None
    if not registry.has_type(type_):
        result.errors.append(MetaError(
            f"unknown type '{type_}'",
            ErrorCode.ERR_UNKNOWN_TYPE,
            source,
            envelope=_current_envelope(source, builder, yaml_position),
        ))
        return None
    definition = registry.find(type_, sub_type)
    if definition is None:
        result.errors.append(MetaError(
            f"unknown subType '{type_}.{sub_type}'",
            ErrorCode.ERR_UNKNOWN_SUBTYPE,
            source,
            envelope=_current_envelope(source, builder, yaml_position),
        ))
        return None

    body_dict: dict[str, object] = body if isinstance(body, dict) else {}
    name = str(body_dict.get(KEY_NAME, "") or "")
    # Config-driven default name for a SINGLETON child type (max_occurs == 1 with
    # a default_name, e.g. identity.primary -> "primary"). Safe by construction —
    # the singleton constraint (enforced separately) guarantees no collision.
    if name == "" and definition.max_occurs == 1 and definition.default_name is not None:
        name = definition.default_name
    node = definition.factory(type_, sub_type, name)
    assert isinstance(node, MetaData)
    # FR5a / ADR-0009 — every parser-constructed node carries its origin.
    # FR5b — when YAML-sourced, the envelope also carries yaml_position.
    node.set_source(_current_envelope(source, builder, yaml_position))

    pkg = body_dict.get(KEY_PACKAGE)
    # Capture the file-default package at PARSE time so cross-package
    # fully-qualified ``extends`` resolves over the MERGED tree (where per-file
    # root packages are no longer reachable via the parent chain). The node's
    # own ``package`` if declared, else the inherited context package (the
    # file's root package). Mirrors TS ``MetaData.fileDefaultPackage``.
    node.file_default_package = (str(pkg) if pkg else None) or (ctx_pkg or None)

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
        # FR-032 — a relative ``extends`` in canonical JSON is illegal.
        if _guard_relative_ref_in_canonical(
            KEY_EXTENDS, body_dict[KEY_EXTENDS], wrapper, source, result,
            _current_envelope(source, builder, yaml_position),
        ):
            return None
        node.super_ref = str(body_dict[KEY_EXTENDS])
    node.is_abstract = bool(body_dict.get(KEY_ABSTRACT, False))
    node.is_overlay = bool(body_dict.get(KEY_OVERLAY, False))
    node.is_array = bool(body_dict.get(KEY_IS_ARRAY, False))

    for key, value in body_dict.items():
        if key.startswith(ATTR_PREFIX):
            attr_name = key[len(ATTR_PREFIX):]
            # ADR-0007: @-prefixing a reserved structural body key is invalid.
            # Detected inline as each @-attr key is processed (matches TS parser-core).
            # FR5a: emit the envelope at the PARENT body level (do NOT push the
            # offending @-key onto the path) — matches TS parser-core which calls
            # errSource() without descending into the @-key. Pushing would emit
            # a deeper jsonPath than the reference port.
            if attr_name in _RESERVED_STRUCTURAL_KEYS:
                result.errors.append(
                    MetaError(
                        f"node '{wrapper}' uses reserved structural key '{attr_name}' "
                        f"with @-prefix; bare '{attr_name}' is the canonical form",
                        ErrorCode.ERR_RESERVED_ATTR,
                        source,
                        envelope=_current_envelope(source, builder, yaml_position),
                    )
                )
                continue
            # FR-032 — a relative inline ref-attr value in canonical JSON is illegal.
            if attr_name in REF_BEARING_ATTR_NAMES and _guard_relative_ref_in_canonical(
                key, value, wrapper, source, result,
                _current_envelope(source, builder, yaml_position),
            ):
                return None
            schema = registry.attr_schema(type_, sub_type, attr_name)
            # Array-valued attrs (the `string` + is_array model that replaced the
            # `stringarray` subtype) coerce through the array string-attr class
            # (bare-string → one-element list), keyed off the retired-as-a-subtype-
            # but-kept-as-a-coercion `stringarray` class-map entry.
            attr_sub_type = (
                ATTR_SUBTYPE_STRINGARRAY
                if schema is not None and schema.is_array
                else (schema.value_type if schema else None)
            )
            node.set_attr(attr_name, value, sub_type=attr_sub_type)
            # FR5a / ADR-0009 — stamp the just-constructed MetaAttribute node with
            # its origin envelope. Mirrors C# Parser.cs:1039 (attrModel.SetSource).
            # The attr's JsonPath points at the @-key on the parent body.
            # ADR-0039 sanctioned own: fetches the JUST-set OWN attr node (set_attr
            # above) to stamp its origin envelope — a declaration-layer operation, not
            # an effective read (resolving could return an inherited node).
            attr_node = node.own_meta_attr(attr_name)
            if attr_node is not None:
                # FR5b — the inline attr's YAML position is the body's
                # position-by-key map entry for this canonical key (the
                # desugar re-keys sigil-free attrs to @-prefixed form, so
                # the lookup key matches `key` directly).
                attr_yaml_pos = get_yaml_position(body_dict, key)
                builder.push_key(key)
                attr_node.set_source(
                    _current_envelope(source, builder, attr_yaml_pos),
                )
                builder.pop()

    # The context package for children: use this node's own package if set, else inherit.
    child_ctx_pkg = node.package or ctx_pkg

    # Descend into children: push `children` key, then `[i]` index for each entry,
    # then the child wrapper key, so JsonPath segments stack correctly.
    children_entries = _iter_children(body_dict)
    if children_entries:
        builder.push_key(KEY_CHILDREN)
        for idx, (entry_dict, cw, cbody) in enumerate(children_entries):
            builder.push_index(idx)
            builder.push_key(cw)
            child_type, _, child_sub = cw.partition(FUSED_KEY_SEP)
            # FR5b — the child wrapper's YAML position lives on the entry
            # dict (the one-key wrapper holding `{cw: cbody}`). For JSON
            # input, get_yaml_position returns None.
            child_yaml_pos = get_yaml_position(entry_dict, cw)
            if child_type == TYPE_ATTR:
                _parse_attr_child(
                    node, child_sub, cbody, registry, source, result, builder,
                    yaml_position=child_yaml_pos,
                )
            else:
                child = _build(
                    cw, cbody, registry, source, result, builder,
                    ctx_pkg=child_ctx_pkg, parent_type=type_,
                    yaml_position=child_yaml_pos,
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
    yaml_position: YamlPosition | None = None,
) -> None:
    """Handle a typed attr child: { "attr.<sub>": { "name": ..., "value": ... } }.

    Attaches via set_attr (not add_child) — attrs are not structural children.
    Uses the child's own sub_type to pick the correct attr class (coerce + desugar).

    FR5b — *yaml_position* is the YAML line/col of the attr child's wrapper key
    (when YAML-loaded); stamped on the resulting attribute node's source.
    """
    body_dict: dict[str, object] = body if isinstance(body, dict) else {}
    attr_name = body_dict.get(KEY_NAME)
    if not isinstance(attr_name, str) or not attr_name:
        result.errors.append(
            MetaError(
                f"attr child requires a non-empty 'name'",
                ErrorCode.ERR_MISSING_REQUIRED_ATTR,
                source,
                envelope=_current_envelope(source, builder, yaml_position),
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
    # ADR-0039 sanctioned own: fetches the JUST-set OWN attr node (set_attr above)
    # to stamp its origin envelope — a declaration-layer operation, not an effective
    # read.
    attr_node = parent.own_meta_attr(attr_name)
    if attr_node is not None:
        attr_node.set_source(_current_envelope(source, builder, yaml_position))


def _iter_children(
    body: dict[str, object],
) -> list[tuple[dict[str, object], str, object]]:
    """Iterate over a body's `children` entries.

    Returns a list of ``(entry_dict, wrapper_key, body_value)`` triples. The
    ``entry_dict`` is the original one-key wrapper from the children array,
    retained so callers can read its FR5b YAML position-by-key map.
    """
    raw = body.get(KEY_CHILDREN, [])
    out: list[tuple[dict[str, object], str, object]] = []
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict) and len(entry) == 1:
                (cw, cbody), = cast(list[tuple[str, object]], list(entry.items()))
                out.append((entry, cw, cbody))
    return out
