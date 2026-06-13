"""YAML authoring -> canonical desugar (ADR-0006).

Mirrors the TS reference at server/typescript/packages/metadata/src/core/yaml-desugar.ts.

desugar() turns the sugared authoring object (from yaml.safe_load) into the
canonical-shaped object that parse_document (parser.py) consumes. It applies
the five format-spec sugar rules:

  1. Fused key, subType omittable - a bare `type` key resolves to the type's
     registry default subType.
  2. Scalar-or-map body - a scalar body becomes { name: <scalar> }.
  3. Omit empties - absent keys stay absent; the desugar invents nothing.
  4. `[]` arrays - a trailing `[]` on the key strips to isArray: true.
  5. Sigil-free attributes (ADR-0006 D1) - every body key not in
     RESERVED_KEYS is treated as an inline attribute and re-prefixed with `@`
     when lowering to canonical JSON. Keys already prefixed with `@` are
     left as-is (backward-compat). Reserved structural keywords (name,
     package, extends, abstract, overlay, isArray, children, value) stay
     bare. Note: an already-`@`-prefixed reserved word remains an error
     downstream - parser.py's ERR_RESERVED_ATTR check fires.

In addition, the desugar runs the ADR-0006 D2 type-coercion guard: for every
inline attr whose owning (type, subType) has a declared schema, if the raw
Python value's type does not match the declared valueType AND the value is
one of YAML 1.2's silently coerced shapes (bool/int/float/None), the desugar
collects an ERR_YAML_COERCION error telling the author to quote the value.

Pure and total: it never throws. Malformed fragments are collected as
CollectedError entries (a string message + optional stable error code) and a
safe placeholder is substituted so parse_document does not double-report.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .errors import ErrorCode
from .naming_refs import REF_BEARING_ATTR_NAMES, expand_ref
from .meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_CLASS,
    ATTR_SUBTYPE_DOUBLE,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_LONG,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from .registry import AttrSchema, TypeRegistry
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
from .source import YamlPosition
from .source.yaml_positions import (
    YamlPositionMap,
    get_position_map,
    set_position_map,
)

ARRAY_SUFFIX = "[]"

RESERVED_KEYS: frozenset[str] = frozenset({
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
class CollectedError:
    """A collected desugar problem - message plus optional stable error code.

    Absent codes map to ERR_MALFORMED_YAML in parser_yaml.py (matches TS).
    """
    message: str
    code: ErrorCode | None = None


@dataclass
class DesugarResult:
    """Outcome of desugaring a parsed-YAML document."""
    canonical: dict[str, Any] = field(default_factory=dict)
    errors: list[CollectedError] = field(default_factory=list)


def desugar(input_obj: object, registry: TypeRegistry) -> DesugarResult:
    """Desugar a parsed-YAML authoring document into a canonical-shaped object."""
    errors: list[CollectedError] = []
    # FR-032: root package context starts empty; each node's own `package` body
    # key seeds the context threaded down to its children for ref expansion.
    node = _desugar_node(input_obj, registry, errors, "<root>", "")
    return DesugarResult(canonical=node if node is not None else {}, errors=errors)


def _effective_package_for(raw_body: object, parent_pkg: str) -> str:
    """FR-032 (ADR-0032) — compute a node's effective package from its raw
    ``package`` body key (inheriting *parent_pkg* when absent).

    Mirrors TS ``effectivePackageFor`` / the parser's package resolution: a
    leading ``::`` on a child package prepends the parent; otherwise it is used
    as-is. The ``package`` attr itself is never ref-expanded — it is identity.
    """
    if not isinstance(raw_body, dict):
        return parent_pkg
    raw_pkg = raw_body.get(KEY_PACKAGE)
    if not isinstance(raw_pkg, str):
        return parent_pkg
    if parent_pkg != "" and raw_pkg.startswith(PACKAGE_SEP):
        return parent_pkg + raw_pkg
    return raw_pkg


def _expand_ref_value(
    raw: object,
    node_pkg: str,
    errors: list[CollectedError],
    path: str,
    ref_label: str,
) -> object:
    """FR-032 — expand a ref-bearing value to FQN. A ref value is a single string
    (most refs) or a string-array (``@references`` can carry multiple).
    ``expand_ref`` preserves any FR-024 dotted child suffix. A parent-relative
    over-drop is collected as ERR_BAD_ATTR_VALUE and the raw value passes through.
    """
    if isinstance(raw, str):
        try:
            return expand_ref(raw, node_pkg)
        except ValueError as exc:
            errors.append(CollectedError(
                message=f"Cannot expand reference '{ref_label}' at {path}: {exc}",
                code=ErrorCode.ERR_BAD_ATTR_VALUE,
            ))
            return raw
    if isinstance(raw, list):
        return [
            _expand_ref_value(el, node_pkg, errors, path, ref_label)
            if isinstance(el, str)
            else el
            for el in raw
        ]
    return raw


def _desugar_node(
    input_obj: object,
    registry: TypeRegistry,
    errors: list[CollectedError],
    path: str,
    parent_pkg: str,
) -> dict[str, Any] | None:
    """Desugar one node - a single-key mapping { "type.subType": body }.

    Returns the canonical node object, or None if `input_obj` is not a usable
    node (the caller substitutes a placeholder).
    """
    if not isinstance(input_obj, dict):
        errors.append(CollectedError(
            message=f"Node at {path} must be a mapping with one type key",
        ))
        return None

    keys = list(input_obj.keys())
    if len(keys) != 1:
        found = "none" if not keys else ", ".join(str(k) for k in keys)
        errors.append(CollectedError(
            message=(
                f"Node at {path} must have exactly one type key "
                f"(found: {found})"
            ),
        ))
        return None

    raw_key = keys[0]
    if not isinstance(raw_key, str):
        errors.append(CollectedError(
            message=f"Node key at {path} must be a string, got {type(raw_key).__name__}",
        ))
        return None
    raw_body = input_obj[raw_key]

    # FR5b - capture the wrapper-level position-by-key map BEFORE re-keying.
    # The author's raw key (with `[]` suffix and possibly omitted subType) is
    # the lookup key; the desugar's canonical key is what we emit.
    wrapper_positions = get_position_map(input_obj)

    # Rule 4: a trailing "[]" on the key -> isArray.
    key = raw_key
    is_array = False
    if key.endswith(ARRAY_SUFFIX):
        key = key[: -len(ARRAY_SUFFIX)]
        is_array = True

    # Rule 1: a bare `type` key -> the type's registry default subType.
    canonical_key = _resolve_key(key, registry, errors, path)

    # FR-032: this node's effective package context (its own `package` body key,
    # else inherited). Used to expand its ref-bearing attrs AND threaded to its
    # children so their bare/relative refs resolve against the right package.
    node_pkg = _effective_package_for(raw_body, parent_pkg)

    # FR5b - position of the wrapper key (the `field.string:` line). Used to
    # back-fill `yaml_position` on synthesized bodies (Rule 2 scalar lift) and
    # on the canonical wrapper after Rule 1 / Rule 4 rewrites.
    wrapper_key_pos = (
        wrapper_positions.get(raw_key) if wrapper_positions is not None else None
    )

    # Rule 2: a scalar body -> { name: <scalar> }.
    body = _desugar_body(
        raw_body, registry, canonical_key, errors, path, wrapper_key_pos, node_pkg,
    )

    # Rule 4 (cont.): stamp isArray onto the canonical body.
    if is_array:
        body[KEY_IS_ARRAY] = True

    # Recurse into children.
    raw_children = body.get(KEY_CHILDREN)
    if isinstance(raw_children, list):
        children: list[Any] = []
        for i, raw_child in enumerate(raw_children):
            child_path = f"{path}.{KEY_CHILDREN}[{i}]"
            child = _desugar_node(raw_child, registry, errors, child_path, node_pkg)
            # On a bad child keep an empty-object placeholder so sibling
            # indices stay stable; the error is already collected.
            children.append(child if child is not None else {})
        body[KEY_CHILDREN] = children
    # A non-list `children` value is left untouched - parse_document reports it.

    # FR5b - emit a wrapper-level position-by-key map for the canonical wrapper
    # so parse_document's per-child iteration can read the position via the
    # same lookup it uses for JSON input. The single key transformation is
    # raw_key -> canonical_key (Rule 1 fuses the subType, Rule 4 strips `[]`).
    out_wrapper = YamlPositionMap({canonical_key: body})
    if wrapper_key_pos is not None:
        set_position_map(out_wrapper, {canonical_key: wrapper_key_pos})
    return out_wrapper


def _resolve_key(
    key: str,
    registry: TypeRegistry,
    errors: list[CollectedError],
    path: str,
) -> str:
    """Rule 1 - resolve a possibly-bare key to a fused `type.subType` token."""
    if FUSED_KEY_SEP in key:
        return key  # already fused
    sub_type = registry.default_sub_type_of(key)
    if sub_type is None:
        errors.append(CollectedError(
            message=(
                f"Cannot resolve subType for bare type key '{key}' at {path} - "
                f"type '{key}' has no default subType; write the full 'type.subType'"
            ),
        ))
        return key  # pass through; parse_document reports the unknown type
    return f"{key}{FUSED_KEY_SEP}{sub_type}"


def _desugar_body(
    raw_body: object,
    registry: TypeRegistry,
    canonical_key: str,
    errors: list[CollectedError],
    path: str,
    wrapper_key_pos: YamlPosition | None = None,
    node_pkg: str = "",
) -> dict[str, Any]:
    """Rule 2 + 5 - normalize a node body into a canonical mapping.

    Reserved structural keys stay bare; every other key is treated as an inline
    attribute and `@`-prefixed (Rule 5 / ADR-0006 D1). Keys already starting
    with `@` are kept as-authored so the awkward "@column: foo" form remains
    accepted.

    Also runs the D2 type-coercion guard: for each inline attr that the owning
    (type, subType) declares with a typed `value_type`, if the raw Python
    value's type was silently coerced by YAML 1.2 to something incompatible
    (e.g. a `bool` for a `string`-declared attr), an ERR_YAML_COERCION is
    collected.

    FR5b — *wrapper_key_pos* is the YAML position of the wrapper key (the
    ``field.string:`` line) used to back-fill ``yaml_position`` on synthesized
    bodies (Rule 2 scalar lift). Reserved structural keys keep their bare
    form and carry their own positions from the source body's position map;
    sigil-free attrs (Rule 5) re-key the position map across the ``@``-prefix
    rewrite.
    """
    if isinstance(raw_body, str) or isinstance(raw_body, bool) or (
        isinstance(raw_body, (int, float)) and not isinstance(raw_body, bool)
    ):
        # FR5b - the synthesized `{ name: rawBody }` has no YAML-side
        # counterpart; we attribute the `name` slot to the wrapper-key's
        # position (the only YAML position that meaningfully belongs to
        # this synthesis).
        out_scalar = YamlPositionMap({KEY_NAME: raw_body})
        if wrapper_key_pos is not None:
            set_position_map(out_scalar, {KEY_NAME: wrapper_key_pos})
        return out_scalar
    if raw_body is None:
        # An empty body (`field.string:` with nothing after) -> an empty node.
        # No body keys to position; the wrapper carries the node's position.
        return YamlPositionMap()
    if isinstance(raw_body, list):
        errors.append(CollectedError(
            message=f"Node body at {path} must be a scalar or mapping, not a list",
        ))
        return YamlPositionMap()
    if not isinstance(raw_body, dict):
        # Catch-all for non-dict, non-scalar shapes (e.g. tuples).
        errors.append(CollectedError(
            message=f"Node body at {path} must be a scalar or mapping",
        ))
        return YamlPositionMap()

    # A mapping - shallow-copy so isArray / children replacement do not mutate
    # the caller's parsed-YAML object, AND apply Rule 5 (sigil-free attrs) +
    # Rule D2 (type-coercion guard).
    out = YamlPositionMap()
    schema_index = _attr_schema_index(registry, canonical_key)
    # FR5b - translate the body's position-by-key map across the sigil-free
    # rewrite. A bare `filterable` key in the source maps to `@filterable`
    # in the canonical body; the YAML position belongs to BOTH names (the
    # YAML author only wrote one). We re-key the position map to match
    # the canonical body's keys so parse_document's per-attr inspection
    # can find the position via the canonical key.
    src_positions = get_position_map(raw_body)
    out_positions: dict[str, YamlPosition] = {}
    for key, value in raw_body.items():
        if not isinstance(key, str):
            errors.append(CollectedError(
                message=(
                    f"Body key at {path} must be a string, got "
                    f"{type(key).__name__}"
                ),
            ))
            continue

        if key in RESERVED_KEYS or key.startswith(ATTR_PREFIX):
            out_key = key
            # FR-032: expand a ref-bearing value to FQN. `extends` (reserved) and
            # the @-prefixed ref attrs are expanded; everything else is verbatim.
            # The `package` key is never expanded (it is identity).
            attr_name = key[len(ATTR_PREFIX):] if key.startswith(ATTR_PREFIX) else ""
            if key == KEY_EXTENDS or (attr_name and attr_name in REF_BEARING_ATTR_NAMES):
                out[key] = _expand_ref_value(value, node_pkg, errors, path, key)
            else:
                out[key] = value
            # D2 also applies to author-written @-keys (the awkward form).
            if attr_name and attr_name not in RESERVED_KEYS:
                _check_coercion(attr_name, value, schema_index, errors, path)
        else:
            out_key = f"{ATTR_PREFIX}{key}"
            # FR-032: a bare (sigil-free) ref-bearing attr is expanded to FQN too.
            if key in REF_BEARING_ATTR_NAMES:
                out[out_key] = _expand_ref_value(value, node_pkg, errors, path, out_key)
            else:
                out[out_key] = value
            _check_coercion(key, value, schema_index, errors, path)

        if src_positions is not None:
            pos = src_positions.get(key)
            if pos is not None:
                out_positions[out_key] = pos

    if out_positions:
        set_position_map(out, out_positions)
    return out


# ---------------------------------------------------------------------------
# D2 - YAML type-coercion guard
# ---------------------------------------------------------------------------


def _attr_schema_index(
    registry: TypeRegistry,
    canonical_key: str,
) -> dict[str, AttrSchema] | None:
    """Build a name -> AttrSchema map for the given canonical key (type.subType).

    Returns None when the key has no declared attrs (open schema).
    """
    # canonical_key is "type.subType" - split on the FIRST dot only so a subType
    # that happens to contain a dot still works.
    dot = canonical_key.find(FUSED_KEY_SEP)
    if dot < 0:
        return None
    type_ = canonical_key[:dot]
    sub_type = canonical_key[dot + 1:]
    schemas = registry.attrs_of(type_, sub_type)
    if not schemas:
        return None
    return {spec.name: spec for spec in schemas}


def _check_coercion(
    attr_name: str,
    raw: object,
    schema_index: dict[str, AttrSchema] | None,
    errors: list[CollectedError],
    path: str,
) -> None:
    """Check a single attr value against its declared schema's `value_type`.

    Emits ERR_YAML_COERCION when YAML 1.2's core schema silently changed the
    Python type (bool/int/float/None where a string/stringArray was declared,
    or vice versa for booleans/numbers).
    """
    if schema_index is None:
        return
    spec = schema_index.get(attr_name)
    if spec is None or spec.value_type is None:
        return

    # Array-valued attrs (the `string` + is_array model that replaced the
    # `stringarray` subtype): validate as a string array regardless of the scalar
    # value_type token. Also tolerate a legacy stringarray token.
    if spec.is_array or spec.value_type == ATTR_SUBTYPE_STRINGARRAY:
        if isinstance(raw, str):
            return
        if not isinstance(raw, list):
            _emit_coercion(
                attr_name, raw, "string-array (or single string)", errors, path,
            )
            return
        for i, elem in enumerate(raw):
            if not isinstance(elem, str):
                _emit_coercion(
                    f"{attr_name}[{i}]", elem, "string (in string-array)", errors, path,
                )
        return

    if spec.value_type in (ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_CLASS):
        if not isinstance(raw, str):
            _emit_coercion(attr_name, raw, "string", errors, path)
        return
    if spec.value_type == ATTR_SUBTYPE_BOOLEAN:
        if not isinstance(raw, bool):
            _emit_coercion(attr_name, raw, "boolean", errors, path)
        return
    if spec.value_type in (ATTR_SUBTYPE_INT, ATTR_SUBTYPE_LONG, ATTR_SUBTYPE_DOUBLE):
        # In Python, bool is a subclass of int; YAML 1.2 boolean literals
        # (true/false/TRUE/FALSE) should not satisfy a numeric attr.
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            _emit_coercion(attr_name, raw, "number", errors, path)
        return
    if spec.value_type == ATTR_SUBTYPE_STRINGARRAY:
        # A bare string at the value position is the legitimate one-element
        # authoring shorthand for a string-array attr (StringArrayAttr.coerce
        # wraps it into a one-element array). It is NOT a coercion. A
        # non-string non-array scalar (boolean/number/null), however, is.
        if isinstance(raw, str):
            return
        if not isinstance(raw, list):
            _emit_coercion(
                attr_name, raw, "string-array (or single string)", errors, path,
            )
            return
        # For a list, check every element. A non-string element is a YAML
        # coercion (e.g. unquoted `true` in a string-array list).
        for i, elem in enumerate(raw):
            if not isinstance(elem, str):
                _emit_coercion(
                    f"{attr_name}[{i}]",
                    elem,
                    "string (in string-array)",
                    errors,
                    path,
                )
        return
    # Object-shaped attrs (properties, filter) - accept any object/array,
    # no YAML coercion path applies.
    return


def _emit_coercion(
    attr_name: str,
    raw: object,
    expected: str,
    errors: list[CollectedError],
    path: str,
) -> None:
    """Build the "quote this value" error.

    The shape is intentionally explicit so AI authors can act on it: it
    identifies the attr, the (coerced) value, its Python type, the declared
    expected type, and a one-line fix hint.
    """
    actual_type = _coerced_type_name(raw)
    literal = _literal_repr(raw)
    errors.append(CollectedError(
        message=(
            f"Attribute '@{attr_name}' at {path}: expected {expected} but got "
            f"{actual_type} ({literal}). YAML 1.2 silently coerced an unquoted "
            f"value - quote it in YAML: "
            f"'@{attr_name}: \"{literal}\"' not '@{attr_name}: {literal}'."
        ),
        code=ErrorCode.ERR_YAML_COERCION,
    ))


def _coerced_type_name(raw: object) -> str:
    if raw is None:
        return "null"
    if isinstance(raw, bool):
        # bool must be checked before int (Python: bool is subclass of int).
        return "boolean"
    if isinstance(raw, int):
        return "number"
    if isinstance(raw, float):
        return "number"
    if isinstance(raw, str):
        return "string"
    if isinstance(raw, list):
        return "array"
    if isinstance(raw, dict):
        return "object"
    return type(raw).__name__


def _literal_repr(raw: object) -> str:
    if raw is None:
        return "null"
    if isinstance(raw, bool):
        return "true" if raw else "false"
    if isinstance(raw, (int, float)):
        return str(raw)
    if isinstance(raw, str):
        return raw
    # Best-effort JSON-style for non-scalar (for the error message only).
    import json
    try:
        return json.dumps(raw)
    except (TypeError, ValueError):
        return repr(raw)
