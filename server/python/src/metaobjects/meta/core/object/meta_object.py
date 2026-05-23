"""MetaObject — typed accessors over children."""
from __future__ import annotations

from ...meta_data import MetaData
from ..field.meta_field import MetaField


class MetaObject(MetaData):
    def fields(self) -> list[MetaField]:
        return [c for c in self.effective_children() if isinstance(c, MetaField)]
