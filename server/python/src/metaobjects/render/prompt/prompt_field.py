"""FR-010 artifact 1 — one field of an output-format fragment."""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.render.recover import FieldKind
from metaobjects.render.prompt.output_format_spec import OutputFormatSpec


@dataclass(frozen=True, slots=True)
class PromptField:
    """One field of an output-format fragment.

    ``enum_values``/``enum_doc`` are non-None only for ENUM; ``nested`` non-None only
    for OBJECT; ``example``/``instruction`` are nullable.

    Precondition: ``name`` must be identifier-safe (valid XML element name / JSON key).
    The renderer does not escape field names.
    """

    name: str
    kind: FieldKind
    required: bool
    array: bool = False
    enum_values: list[str] | None = None
    enum_doc: dict[str, str] | None = None
    example: str | None = None
    instruction: str | None = None
    nested: OutputFormatSpec | None = None
