"""MetaIndex — concrete node class for type=index nodes."""
from __future__ import annotations

from ...meta_data import MetaData
from .index_constants import INDEX_ATTR_FIELDS, INDEX_SUBTYPE_LOOKUP


class MetaIndex(MetaData):
    def fields(self) -> list[str]:
        """ADR-0039: resolving — @fields may be inherited via extends."""
        f = self.get_meta_attr(INDEX_ATTR_FIELDS)
        return list(f) if isinstance(f, list) else []

    def is_lookup(self) -> bool:
        return self.sub_type == INDEX_SUBTYPE_LOOKUP
