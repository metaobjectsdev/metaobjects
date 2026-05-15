"""Concrete node — a field."""
from __future__ import annotations

from .meta_data import MetaData


class MetaField(MetaData):
    def __init__(self, sub_type: str, name: str) -> None:
        super().__init__("field", sub_type, name)

    def validators(self) -> list[MetaData]:
        """Effective validators — own + super-chain-inherited."""
        return self._cached(
            "validators",
            lambda: [c for c in self.effective_children() if c.type == "validator"],
        )
