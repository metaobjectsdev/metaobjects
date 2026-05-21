"""Concrete node — an object/entity."""
from __future__ import annotations

from .meta_data import MetaData
from .meta_field import MetaField


class MetaObject(MetaData):
    def __init__(self, sub_type: str, name: str) -> None:
        super().__init__("object", sub_type, name)

    def fields(self) -> list[MetaField]:
        """Effective fields — own + super-chain-inherited."""
        return self._cached(
            "fields",
            lambda: [c for c in self.effective_children() if isinstance(c, MetaField)],
        )

    def own_fields(self) -> list[MetaField]:
        """Own fields only — excludes inherited."""
        return [c for c in self.children() if isinstance(c, MetaField)]
