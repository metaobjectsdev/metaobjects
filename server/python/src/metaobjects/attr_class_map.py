"""Dependency-free registry: attr subtype -> MetaAttr class. Breaks the meta-data import cycle."""
from __future__ import annotations

from typing import Callable

_ATTR_CLASSES: dict[str, Callable[..., object]] = {}
_FALLBACK: Callable[..., object] | None = None


def register_attr_class(sub_type: str, ctor: Callable[..., object]) -> None:
    _ATTR_CLASSES[sub_type] = ctor


def register_fallback_attr_class(ctor: Callable[..., object]) -> None:
    global _FALLBACK
    _FALLBACK = ctor


def attr_class_for(sub_type: str) -> Callable[..., object]:
    ctor = _ATTR_CLASSES.get(sub_type, _FALLBACK)
    if ctor is None:
        raise RuntimeError("attr classes not registered (import metaobjects.core_types first)")
    return ctor
