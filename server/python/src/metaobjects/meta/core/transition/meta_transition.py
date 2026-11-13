"""MetaTransition — node class for ``transition.*`` (ADR-0063). Accessors are RESOLVING
(ADR-0039): a transition declared on a base entity's field applies, unchanged, to every
entity that extends it. Python ``attr()`` is own-only, so reads go through
``get_meta_attr()``. Mirrors TS ``core/transition/meta-transition.ts``.
"""
from __future__ import annotations

from ...meta_data import MetaData
from .transition_constants import (
    TRANSITION_ATTR_CONDITION,
    TRANSITION_ATTR_FROM,
    TRANSITION_ATTR_PERMISSION,
    TRANSITION_ATTR_PUBLIC,
    TRANSITION_ATTR_TO,
)


class MetaTransition(MetaData):
    def from_states(self) -> list[str]:
        """The states this move may start from. A bare string is one element."""
        v = self.get_meta_attr(TRANSITION_ATTR_FROM)  # ADR-0039: resolving
        if isinstance(v, list):
            return [x for x in v if isinstance(x, str)]
        return [v] if isinstance(v, str) else []

    def to(self) -> str | None:
        v = self.get_meta_attr(TRANSITION_ATTR_TO)
        return v if isinstance(v, str) else None

    def condition(self) -> object:
        return self.get_meta_attr(TRANSITION_ATTR_CONDITION)

    def permission(self) -> str | None:
        v = self.get_meta_attr(TRANSITION_ATTR_PERMISSION)
        return v if isinstance(v, str) else None

    def is_public(self) -> bool:
        return self.get_meta_attr(TRANSITION_ATTR_PUBLIC) is True
