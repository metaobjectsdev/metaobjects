"""Canonical (fused-key) serializer. Deterministic per spec/conformance-tests.md."""
from __future__ import annotations

import json

from .meta.meta_data import MetaData
from .meta.persistence.source.source_constants import (
    DEFAULT_SOURCE_KIND,
    PHYSICAL_NAME_ATTR_BY_KIND,
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_TABLE,
    SOURCE_SUBTYPE_RDB,
)
from .shared.base_types import TYPE_SOURCE
from .shared.separators import ATTR_PREFIX, FUSED_KEY_SEP
from .shared.structural import (
    KEY_ABSTRACT,
    KEY_CHILDREN,
    KEY_EXTENDS,
    KEY_IS_ARRAY,
    KEY_NAME,
    KEY_PACKAGE,
)

_SOURCE_RDB_FUSED_KEY = f"{TYPE_SOURCE}{FUSED_KEY_SEP}{SOURCE_SUBTYPE_RDB}"


def canonical_serialize(node: MetaData) -> str:
    return _serialize(node, effective=False)


def canonical_serialize_effective(node: MetaData) -> str:
    """Like :func:`canonical_serialize`, but emits the EFFECTIVE tree —
    ``children()`` + ``attrs()`` at every node (own + inherited via the super
    chain), so the super-chain merge is materialized in the output.

    Used by the conformance harness's ``expected-effective.json`` fixtures.
    Mirrors the TS reference ``canonicalSerializeEffective``: ``extends`` is
    still emitted on every node (the ref stays in the body), but inherited
    members are inlined rather than referenced.
    """
    return _serialize(node, effective=True)


def _serialize(node: MetaData, effective: bool) -> str:
    parsed = _to_canonical(node, effective)
    # FR-016 / ADR-0018 — rewrite legacy @table → kind-matching alias on
    # source.rdb wrappers; run before serialization so the rewritten key sorts
    # naturally with the rest of the body (alphabetical at our depth).
    _rewrite_source_rdb_physical_names(parsed)
    text = json.dumps(parsed, indent=2, ensure_ascii=False)
    return text + "\n"


def _to_canonical(node: MetaData, effective: bool = False) -> dict[str, object]:
    return {f"{node.type}{FUSED_KEY_SEP}{node.sub_type}": _body(node, effective)}


def _body(node: MetaData, effective: bool = False) -> dict[str, object]:
    body: dict[str, object] = {}
    if node.name:
        body[KEY_NAME] = node.name
    if node.package:
        body[KEY_PACKAGE] = node.package
    if node.super_ref:
        body[KEY_EXTENDS] = node.super_ref
    if node.is_abstract:
        body[KEY_ABSTRACT] = True
    # ADR-0039 — isArray is a native property; in EFFECTIVE mode it must resolve
    # through the extends super chain (a concrete field inheriting isArray:true
    # from an abstract parent), whereas own-mode emits only the locally-declared
    # flag (round-trips the authored form).
    if node.resolved_is_array() if effective else node.is_array:
        body[KEY_IS_ARRAY] = True

    # In effective mode use attrs()/children() (own + inherited via the super
    # chain); in own mode use own_meta_attrs()/own_children() (declared here).
    if effective:
        for name in sorted(node.attrs()):
            body[f"{ATTR_PREFIX}{name}"] = _normalize(node.attrs()[name])
    else:
        for attr in sorted(node.own_meta_attrs(), key=lambda a: a.name):
            body[f"{ATTR_PREFIX}{attr.name}"] = _normalize(getattr(attr, "value", None))

    children = node.children() if effective else node.own_children()
    if children:
        body[KEY_CHILDREN] = [_to_canonical(c, effective) for c in children]
    return body


def _rewrite_source_rdb_physical_names(value: object) -> None:
    """FR-016 / ADR-0018 — rewrite legacy ``@table`` on source.rdb wrappers
    whose ``@kind`` is non-table to the kind-matching alias
    (``@view`` / ``@materializedView`` / ``@proc`` / ``@function``).

    Mutates the parsed JSON in place; idempotent and a no-op for canonical
    inputs (mirrors the TS reference ``rewriteSourceRdbPhysicalNames``).
    """
    if isinstance(value, list):
        for item in value:
            _rewrite_source_rdb_physical_names(item)
        return
    if not isinstance(value, dict):
        return

    rdb_body = value.get(_SOURCE_RDB_FUSED_KEY)
    if isinstance(rdb_body, dict):
        kind_raw = rdb_body.get(f"{ATTR_PREFIX}{SOURCE_ATTR_KIND}")
        kind = kind_raw if isinstance(kind_raw, str) and kind_raw else DEFAULT_SOURCE_KIND
        canonical_alias = PHYSICAL_NAME_ATTR_BY_KIND.get(kind)
        if canonical_alias is not None and canonical_alias != SOURCE_ATTR_TABLE:
            legacy_key = f"{ATTR_PREFIX}{SOURCE_ATTR_TABLE}"
            canonical_key = f"{ATTR_PREFIX}{canonical_alias}"
            legacy_value = rdb_body.get(legacy_key)
            if legacy_value is not None and canonical_key not in rdb_body:
                # Re-insert in alphabetical position by rebuilding the dict.
                new_body: dict[str, object] = {}
                # The rewrite changes the key — preserve original insertion
                # order semantics by walking, swapping in the canonical key in
                # @table's slot, then re-sorting only the @-prefixed keys.
                for k, v in rdb_body.items():
                    if k == legacy_key:
                        continue
                    new_body[k] = v
                new_body[canonical_key] = legacy_value
                # Restore structural-then-attr ordering with attrs alphabetically.
                struct_keys = [
                    KEY_NAME, KEY_PACKAGE, KEY_EXTENDS,
                    KEY_ABSTRACT, KEY_IS_ARRAY,
                ]
                ordered: dict[str, object] = {}
                for k in struct_keys:
                    if k in new_body:
                        ordered[k] = new_body[k]
                attr_keys = sorted(
                    k for k in new_body
                    if k.startswith(ATTR_PREFIX)
                )
                for k in attr_keys:
                    ordered[k] = new_body[k]
                if KEY_CHILDREN in new_body:
                    ordered[KEY_CHILDREN] = new_body[KEY_CHILDREN]
                rdb_body.clear()
                rdb_body.update(ordered)

    # Recurse through every value (in particular ``children``).
    for v in value.values():
        _rewrite_source_rdb_physical_names(v)


_SCALAR_TYPES = (str, int, float, bool, type(None))


def _normalize(value: object) -> object:
    """Mirror JSON.stringify: a whole-number float serializes as an int.

    Object-valued attrs need different key order in canonical form, and the
    serializer is schema-free — so distinguish by value shape, which exactly
    tracks the object-attr subtypes:
      * `properties` (e.g. @enumDoc / @enumAlias) is a flat scalar->scalar map ->
        keys sort ordinally (cross-port canonical form; matches the Java
        reference, whose Properties is unordered and serializes sorted).
      * `filter` maps a field to an operator object ({eq:...}/{in:[...]}) — at
        least one value is itself a dict/list -> declaration order is preserved
        (significant). The FilterAttr desugar runs at set_value time, so filter
        values are always op-object dicts before serialization reaches here.
    """
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    if isinstance(value, dict):
        all_scalar = all(isinstance(v, _SCALAR_TYPES) for v in value.values())
        items = sorted(value.items()) if all_scalar else value.items()
        return {k: _normalize(v) for k, v in items}
    return value
