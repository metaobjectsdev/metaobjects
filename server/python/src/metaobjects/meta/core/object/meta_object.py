"""MetaObject — typed accessors over children."""
from __future__ import annotations

from ...meta_data import MetaData
from ..field.meta_field import MetaField


class MetaObject(MetaData):
    def fields(self) -> list[MetaField]:
        """Effective fields: own + inherited via super chain (uses children())."""
        return [c for c in self.children() if isinstance(c, MetaField)]

    def own_fields(self) -> list[MetaField]:
        """Own fields only — direct children, no inherited fields from super."""
        return [c for c in self.own_children() if isinstance(c, MetaField)]

    def find_field(self, name: str) -> MetaField | None:
        """Find a field by name in effective fields (own + inherited)."""
        return next((f for f in self.fields() if f.name == name), None)

    def primary_identity(self) -> "MetaIdentity | None":  # type: ignore[name-defined]
        """Primary identity node from effective children (own or inherited)."""
        from ..identity.meta_identity import MetaIdentity
        from ..identity.identity_constants import IDENTITY_SUBTYPE_PRIMARY
        return next(
            (c for c in self.children()
             if isinstance(c, MetaIdentity) and c.sub_type == IDENTITY_SUBTYPE_PRIMARY),
            None,
        )
