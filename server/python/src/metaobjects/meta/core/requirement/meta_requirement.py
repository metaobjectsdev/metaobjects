"""MetaRequirement — concrete node class for type=requirement nodes.

Extends MetaData directly: no model wrapper, no indirection. Accessors are
RESOLVING (ADR-0039) so a requirement that ``extends`` an abstract parent
inherits its properties — note the Python naming inversion: ``attr()`` is
OWN-ONLY here, so every read below goes through ``get_meta_attr()``.
"""
from __future__ import annotations

from ...meta_data import MetaData
from .requirement_constants import (
    REQUIREMENT_ATTR_IMPLEMENTED_BY,
    REQUIREMENT_ATTR_LEVEL,
    REQUIREMENT_ATTR_STATUS,
    REQUIREMENT_ATTR_VERIFIED_BY,
    REQUIREMENT_LINK_FLOOR_LEVEL,
    REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
    REQUIREMENT_SUBTYPE_ARCHITECTURAL,
    REQUIREMENT_SUBTYPE_FUNCTIONAL,
)


class MetaRequirement(MetaData):
    def is_functional(self) -> bool:
        """What the product does for a user — checked by EXISTENCE."""
        return self.sub_type == REQUIREMENT_SUBTYPE_FUNCTIONAL

    def is_architectural(self) -> bool:
        """How the system is built — checked by UNIVERSALITY (the opposite polarity)."""
        return self.sub_type == REQUIREMENT_SUBTYPE_ARCHITECTURAL

    def level(self) -> int | None:
        """ADR-0039: resolving. 1 solution · 2 segment · 3 service · 4 object ·
        5 member. Architectural requirements carry none — they are
        object-independent by definition."""
        v = self.get_meta_attr(REQUIREMENT_ATTR_LEVEL)
        return v if isinstance(v, int) and not isinstance(v, bool) else None

    def status(self) -> str | None:
        """ADR-0039: resolving. One of REQUIREMENT_STATUSES (a closed enum the
        registry enforces via allowed_values)."""
        v = self.get_meta_attr(REQUIREMENT_ATTR_STATUS)
        return v if isinstance(v, str) else None

    def implemented_by(self) -> list[str]:
        """ADR-0039: resolving. FQN references to the model nodes realising this
        requirement (many-to-many by construction)."""
        v = self.get_meta_attr(REQUIREMENT_ATTR_IMPLEMENTED_BY)
        return [str(x) for x in v] if isinstance(v, list) else []

    def verified_by(self) -> list[str]:
        """ADR-0039: resolving. Names of the tests proving the behaviour."""
        v = self.get_meta_attr(REQUIREMENT_ATTR_VERIFIED_BY)
        return [str(x) for x in v] if isinstance(v, list) else []

    def may_reference_model(self) -> bool:
        """True when this requirement is permitted to reference the model at all.
        Architectural requirements always may (their claim set is the point);
        functional ones only at or below the link floor, so the organisational
        tiers stay organisational."""
        if self.is_architectural():
            return True
        lvl = self.level()
        return lvl is not None and lvl >= REQUIREMENT_LINK_FLOOR_LEVEL

    def requires_live_nodes(self) -> bool:
        """True when a dangling ``@implementedBy`` is an ERROR rather than
        expected. An abandoned or superseded requirement's nodes are supposed to
        be gone."""
        s = self.status()
        return s is not None and s in REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES
