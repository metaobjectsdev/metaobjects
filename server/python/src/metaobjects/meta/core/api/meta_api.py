"""Node classes for the declared API surface (ADR-0030, ADR-0063): ``api.*``,
``operation.*`` and ``binding.*``. Accessors are RESOLVING (ADR-0039) — Python naming
inversion: ``attr()`` is own-only, so reads go through ``get_meta_attr()``.
Mirrors TS ``core/api/meta-api.ts``.
"""
from __future__ import annotations

from ...meta_data import MetaData
from ....shared.base_types import TYPE_BINDING, TYPE_OPERATION
from .api_constants import (
    BINDING_ATTR_METHOD,
    BINDING_ATTR_PATH,
    OPERATION_ATTR_ERRORS,
    OPERATION_ATTR_INPUT_REF,
    OPERATION_ATTR_MANY,
    OPERATION_ATTR_OBJECT_REF,
    OPERATION_ATTR_OUTPUT_REF,
    OPERATION_ATTR_PERMISSION,
    OPERATION_ATTR_PUBLIC,
    OPERATION_ATTR_TRANSITIONS,
)


def _string_attr(node: MetaData, name: str) -> str | None:
    v = node.get_meta_attr(name)  # ADR-0039: resolving
    return v if isinstance(v, str) else None


def _string_list_attr(node: MetaData, name: str) -> list[str]:
    """A bare string authored for an array attr is ONE element."""
    v = node.get_meta_attr(name)  # ADR-0039: resolving
    if isinstance(v, list):
        return [x for x in v if isinstance(x, str)]
    return [v] if isinstance(v, str) else []


class MetaApi(MetaData):
    """``api.operational`` — a named surface whose children are operations."""

    def operations(self) -> list["MetaOperation"]:
        return [c for c in self.children() if c.type == TYPE_OPERATION and isinstance(c, MetaOperation)]


class MetaOperation(MetaData):
    """``operation.command`` / ``operation.query``."""

    def input_ref(self) -> str | None:
        return _string_attr(self, OPERATION_ATTR_INPUT_REF)

    def output_ref(self) -> str | None:
        return _string_attr(self, OPERATION_ATTR_OUTPUT_REF)

    def object_ref(self) -> str | None:
        return _string_attr(self, OPERATION_ATTR_OBJECT_REF)

    def transitions(self) -> list[str]:
        return _string_list_attr(self, OPERATION_ATTR_TRANSITIONS)

    def errors(self) -> list[str]:
        return _string_list_attr(self, OPERATION_ATTR_ERRORS)

    def permission(self) -> str | None:
        return _string_attr(self, OPERATION_ATTR_PERMISSION)

    def is_public(self) -> bool:
        return self.get_meta_attr(OPERATION_ATTR_PUBLIC) is True

    def is_many(self) -> bool:
        return self.get_meta_attr(OPERATION_ATTR_MANY) is True

    def bindings(self) -> list["MetaBinding"]:
        return [c for c in self.children() if c.type == TYPE_BINDING and isinstance(c, MetaBinding)]


class MetaBinding(MetaData):
    """``binding.rest``."""

    def method(self) -> str | None:
        return _string_attr(self, BINDING_ATTR_METHOD)

    def path(self) -> str | None:
        return _string_attr(self, BINDING_ATTR_PATH)
