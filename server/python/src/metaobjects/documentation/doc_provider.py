"""The DocumentationProvider — registers the 7 common doc attrs on every metatype."""
from __future__ import annotations

from ..provider import Provider
from ..registry import TypeRegistry
from .doc_schema import common_doc_attrs


class _DocProvider(Provider):
    """Subclass of Provider that also registers common doc attrs into the registry."""

    def register_types(self, registry: TypeRegistry) -> None:
        super().register_types(registry)
        registry.register_common_attrs(common_doc_attrs)


doc_provider = _DocProvider(
    "metaobjects-documentation",
    dependencies=("metaobjects-core-types",),
)
