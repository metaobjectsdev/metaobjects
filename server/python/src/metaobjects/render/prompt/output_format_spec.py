"""FR-010 artifact 1 — a complete output-format descriptor."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from metaobjects.render.extract import Format
from metaobjects.render.prompt.prompt_style import PromptStyle

if TYPE_CHECKING:
    from metaobjects.render.prompt.prompt_field import PromptField


@dataclass(frozen=True, slots=True)
class OutputFormatSpec:
    """A complete output-format descriptor.

    The format, the root element/object name, the default presentation style, and the
    ordered fields. Drives :func:`render_output_format`.

    Precondition: ``root_name`` must be identifier-safe (valid XML element name / JSON
    key). The renderer does not escape it.
    """

    format: Format
    root_name: str
    style: PromptStyle
    fields: list[PromptField] = field(default_factory=list)
