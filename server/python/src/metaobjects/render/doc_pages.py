"""Rendering a docs page from a shared Mustache template (``templates/<group>/<name>.mustache``).

The documentation generators (``requirements``, ``agent-docs``) feed a template the data a
builder computed. The templates ship with the package (``bundled_templates/``, a byte copy of
the repo-root ``templates/`` that ``scripts/sync-doc-templates.sh`` maintains and the
``doc-template drift`` gate holds), and a project overrides a page by dropping a same-named
file under its own templates directory.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from metaobjects.render import escapers
from metaobjects.render.filesystem_provider import FilesystemProvider
from metaobjects.render.renderer import RenderError, RenderRequest, render
from metaobjects.render.verify import Provider

#: The directory the bundled copy of the shared doc templates lives in.
BUNDLED_TEMPLATES_DIR = Path(__file__).resolve().parent / "bundled_templates"


class LayeredProvider:
    """The project's templates first, the bundled ones behind them."""

    def __init__(self, *providers: FilesystemProvider) -> None:
        self._providers = providers

    def resolve(self, ref: str | None) -> str | None:
        for p in self._providers:
            found = p.resolve(ref)
            if found is not None:
                return found
        return None

    def engine_of(self, ref: str) -> str | None:
        for p in self._providers:
            if p.resolve(ref) is not None:
                return p.engine_of(ref)
        return None


def doc_provider(template_root: str | Path | None = None) -> Provider:
    """The provider doc pages resolve from: *template_root* (a project's templates directory)
    overrides a bundled page of the same ref."""
    layers = [FilesystemProvider(BUNDLED_TEMPLATES_DIR)]
    if template_root:
        layers.insert(0, FilesystemProvider(template_root))
    return LayeredProvider(*layers)


def end_with_one_newline(page: str) -> str:
    """A page ends on exactly one line break, whichever section came last."""
    return page.rstrip("\n") + "\n"


def render_doc_page(ref: str, payload: Any, provider: Provider, path: str) -> str:
    """Render one Markdown docs page; an engine error names the page ref and the output path."""
    try:
        return render(RenderRequest(ref=ref, payload=payload, provider=provider, format=escapers.FORMAT_MARKDOWN))
    except RenderError as err:
        raise RenderError(f"docs-file: failed rendering '{ref}' for '{path}': {err}") from err
