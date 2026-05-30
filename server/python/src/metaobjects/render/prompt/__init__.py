"""FR-010 artifact 1 — output-format prompt renderer ("produce your answer like this").

Renders an :class:`OutputFormatSpec` into a prompt fragment that teaches an LLM how
to shape its answer. Three comment-free styles (guide / inline / exampleOnly) × two
formats (json / xml). Guidance is carried in prose / inline placeholders / a filled
skeleton — NEVER in comments (models ignore them).

Cross-port INVARIANT: the rendered text is byte-identical to the Java/C#/Kotlin/TS
reference (``com.metaobjects.render.prompt.OutputFormatRenderer``).
"""
from __future__ import annotations

from metaobjects.render.prompt.output_format_renderer import render_output_format
from metaobjects.render.prompt.output_format_spec import OutputFormatSpec
from metaobjects.render.prompt.prompt_field import PromptField
from metaobjects.render.prompt.prompt_overrides import (
    PROMPT_OVERRIDES_NONE,
    PromptOverrides,
    no_overrides,
)
from metaobjects.render.prompt.prompt_style import PromptStyle, prompt_style_from

__all__ = [
    "PROMPT_OVERRIDES_NONE",
    "OutputFormatSpec",
    "PromptField",
    "PromptOverrides",
    "PromptStyle",
    "no_overrides",
    "prompt_style_from",
    "render_output_format",
]
