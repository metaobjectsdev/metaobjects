"""FR-010 artifact 1 — render-time overrides of the metadata defaults."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final

from metaobjects.render.prompt.prompt_style import PromptStyle


@dataclass(frozen=True, slots=True)
class PromptOverrides:
    """Render-time overrides of the metadata defaults.

    ``style`` of ``None`` keeps the spec's style; the maps override
    ``PromptField.example``/``PromptField.instruction`` per field name.
    """

    style: PromptStyle | None = None
    examples: dict[str, str] = field(default_factory=dict)
    instructions: dict[str, str] = field(default_factory=dict)


# No overrides — keep every metadata default. Mirrors Java ``PromptOverrides.none()``.
PROMPT_OVERRIDES_NONE: Final = PromptOverrides()


def no_overrides() -> PromptOverrides:
    """No overrides — keep every metadata default."""
    return PROMPT_OVERRIDES_NONE
