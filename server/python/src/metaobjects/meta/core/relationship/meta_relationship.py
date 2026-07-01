"""MetaRelationship — relationship.association / aggregation / composition node."""
from __future__ import annotations

from ...meta_data import MetaData
from .relationship_constants import (
    RELATIONSHIP_ATTR_CARDINALITY,
    RELATIONSHIP_ATTR_OBJECT_REF,
    RELATIONSHIP_ATTR_ON_DELETE,
    RELATIONSHIP_ATTR_ON_UPDATE,
    RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
    RELATIONSHIP_ATTR_SYMMETRIC,
    RELATIONSHIP_ATTR_THROUGH,
)


class MetaRelationship(MetaData):
    """A relationship.* node.

    ADR-0039 — every getter below uses the RESOLVING ``get_meta_attr`` accessor,
    matching the TS reference (``this.attr``) and Java port (``getMetaAttr``): a
    relationship attr may be inherited from an abstract base via ``extends``, so
    reading own-only (Python ``attr()``) would silently drop it. Defaults for
    @onDelete/@onUpdate are resolved at consumption time (codegen), not here."""

    def cardinality(self) -> str | None:
        v = self.get_meta_attr(RELATIONSHIP_ATTR_CARDINALITY)
        return v if isinstance(v, str) else None

    def object_ref(self) -> str | None:
        """FQN of the target object (e.g., ``"acme::vehicle::Car"``)."""
        v = self.get_meta_attr(RELATIONSHIP_ATTR_OBJECT_REF)
        return v if isinstance(v, str) else None

    def through(self) -> str | None:
        """Junction (through) entity name for M:N relationships."""
        v = self.get_meta_attr(RELATIONSHIP_ATTR_THROUGH)
        return v if isinstance(v, str) else None

    def source_ref_field(self) -> str | None:
        """Source-side FK field on the junction (directed self-join disambiguator)."""
        v = self.get_meta_attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD)
        return v if isinstance(v, str) else None

    def symmetric(self) -> bool:
        """Whether this M:N relationship is an undirected (symmetric) self-join."""
        return self.get_meta_attr(RELATIONSHIP_ATTR_SYMMETRIC) is True

    def on_delete(self) -> str | None:
        """Referential action on parent delete. ``None`` when not explicitly set
        (default derives from subtype at consumption time)."""
        v = self.get_meta_attr(RELATIONSHIP_ATTR_ON_DELETE)
        return v if isinstance(v, str) and v else None

    def on_update(self) -> str | None:
        """Referential action on key update. ``None`` when not explicitly set
        (default: cascade at consumption time)."""
        v = self.get_meta_attr(RELATIONSHIP_ATTR_ON_UPDATE)
        return v if isinstance(v, str) and v else None
