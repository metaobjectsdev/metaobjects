"""MetaRequirement — concrete node class for type=requirement nodes.

Extends MetaData directly: no model wrapper, no indirection. Accessors are
RESOLVING (ADR-0039) so a requirement that ``extends`` an abstract parent
inherits its properties — note the Python naming inversion: ``attr()`` is
OWN-ONLY here, so every read below goes through ``get_meta_attr()``.
"""
from __future__ import annotations

from ...meta_data import MetaData
from .requirement_constants import (
    REQUIREMENT_ATTR_DISPOSITION,
    REQUIREMENT_ATTR_IMPLEMENTED_BY,
    REQUIREMENT_ATTR_LEVEL,
    REQUIREMENT_ATTR_STATUS,
    REQUIREMENT_ATTR_TRACKED_BY,
    REQUIREMENT_LINK_FLOOR_LEVEL,
    REQUIREMENT_STATUS_PLANNED,
    REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
    REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK,
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
        5 member. REQUIRED on functional; OPTIONAL on architectural, where absent
        means a flat object-independent policy and present opts the node into a
        levelled tree (e.g. a quality taxonomy over the non-functional set)."""
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

    def disposition(self) -> str | None:
        """ADR-0039: resolving. What was DECIDED about the outstanding work — a
        different question from whether the work is done, which is what
        ``status`` answers. ``None`` means UNDECIDED, a real state and the one a
        review exists to find."""
        v = self.get_meta_attr(REQUIREMENT_ATTR_DISPOSITION)
        return v if isinstance(v, str) else None

    def tracked_by(self) -> list[str]:
        """ADR-0039: resolving. Issue/ticket references for outstanding work.
        Free-form and NEVER resolved — verify has no network, so nothing here is
        checked to exist."""
        v = self.get_meta_attr(REQUIREMENT_ATTR_TRACKED_BY)
        return [str(x) for x in v] if isinstance(v, list) else []

    def is_planned(self) -> bool:
        """Intended but not built. Its nodes may legitimately not exist yet, and
        it must NOT count toward object coverage — planning a capability cannot
        be allowed to silence the warning that nothing implements it."""
        return self.status() == REQUIREMENT_STATUS_PLANNED

    def has_outstanding_work(self) -> bool:
        """True when there is outstanding work, so a ``disposition`` says
        something."""
        s = self.status()
        return s is not None and s in REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK

    def may_reference_model(self) -> bool:
        """True when this requirement is permitted to reference the model at all.

        An UNLEVELLED architectural requirement always may — its claim set is the
        whole point, and that is the original flat form. Once a level is PRESENT
        the node has opted into a tree, and the link floor applies to it exactly
        as it does to a functional one, so an "ISO 25010 Security" grouping node
        cannot quietly start naming entities. Levelling is the opt-in; enforcing
        the floor unconditionally would have broken every existing flat policy."""
        lvl = self.level()
        if lvl is None:
            return self.is_architectural()
        return lvl >= REQUIREMENT_LINK_FLOOR_LEVEL

    def requires_live_nodes(self) -> bool:
        """True when a dangling ``@implementedBy`` is an ERROR rather than
        expected. `planned` is the only exemption — there the nodes do not exist YET. The nodes are supposed to
        be gone."""
        s = self.status()
        return s is not None and s in REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES
