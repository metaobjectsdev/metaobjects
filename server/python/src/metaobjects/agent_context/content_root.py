"""Resolve the ``agent-context/`` content tree the assembler reads.

Two resolution sources (matching the TS reference's bundled-then-monorepo walk):

1. A bundled copy shipped inside the installed wheel, at
   ``metaobjects/agent_context/_content/`` (vendored at build time by the custom
   hatch build hook ``hatch_build.py``). This is the published path.
2. A dev fallback: walk up from this module to the monorepo root and use its
   top-level ``agent-context/`` directory.

A directory is a valid content root iff it holds the authoring skill body.
"""

from __future__ import annotations

from pathlib import Path

#: Where the bundled copy lands inside the package (see pyproject force-include).
_BUNDLED = Path(__file__).resolve().parent / "_content"


def _is_content_root(directory: Path) -> bool:
    """A directory is a valid content root iff it holds the authoring skill body."""
    return (directory / "skills" / "metaobjects-authoring" / "SKILL.md").is_file()


def resolve_agent_context_root(override: Path | None = None) -> Path:
    """Resolve the content tree.

    - If ``override`` is given, it must be a valid content root (else raise).
    - Else: prefer the bundled copy beside this module (published path); fall back
      to a monorepo ``agent-context/`` found by walking up from this module (dev).
    """
    if override is not None:
        if _is_content_root(override):
            return override
        raise FileNotFoundError(
            f"agent-context content not found at override: {override}"
        )

    if _is_content_root(_BUNDLED):
        return _BUNDLED

    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "agent-context"
        if _is_content_root(candidate):
            return candidate

    raise FileNotFoundError(
        "agent-context content not found — looked for a bundled copy beside the "
        "package (metaobjects/agent_context/_content) and a monorepo "
        "`agent-context/` walking up from this module."
    )
