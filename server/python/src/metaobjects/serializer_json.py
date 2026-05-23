"""Canonical (fused-key) serializer. Deterministic per spec/conformance-tests.md."""
from __future__ import annotations

import json

from .meta.meta_data import MetaData
from .shared.separators import ATTR_PREFIX, FUSED_KEY_SEP
from .shared.structural import (
    KEY_ABSTRACT,
    KEY_CHILDREN,
    KEY_EXTENDS,
    KEY_IS_ARRAY,
    KEY_NAME,
    KEY_PACKAGE,
)


def canonical_serialize(node: MetaData) -> str:
    text = json.dumps(_to_canonical(node), indent=2, ensure_ascii=False)
    return text + "\n"


def _to_canonical(node: MetaData) -> dict[str, object]:
    return {f"{node.type}{FUSED_KEY_SEP}{node.sub_type}": _body(node)}


def _body(node: MetaData) -> dict[str, object]:
    body: dict[str, object] = {}
    if node.name:
        body[KEY_NAME] = node.name
    if node.package:
        body[KEY_PACKAGE] = node.package
    if node.super_ref:
        body[KEY_EXTENDS] = node.super_ref
    if node.is_abstract:
        body[KEY_ABSTRACT] = True
    if node.is_array:
        body[KEY_IS_ARRAY] = True

    for attr in sorted(node.own_meta_attrs(), key=lambda a: a.name):
        body[f"{ATTR_PREFIX}{attr.name}"] = _normalize(getattr(attr, "value", None))

    children = node.children()
    if children:
        body[KEY_CHILDREN] = [_to_canonical(c) for c in children]
    return body


def _normalize(value: object) -> object:
    """Mirror JSON.stringify: a whole-number float serializes as an int."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value
