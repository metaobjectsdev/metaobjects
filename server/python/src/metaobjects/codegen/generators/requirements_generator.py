"""``requirements`` — the requirement ledger as documentation: ``requirements.md`` for people and
``requirements.toon`` for tools.

An ordinary entry in a target's ``generators`` (the ``docs`` target by convention), run by
``metaobjects gen``. A model declaring no ``requirement.*`` node gets no file.

Each page is the shared Mustache template (``templates/requirements/``, bundled with the
package) fed the data the builder in ``codegen/runtime/docs_requirements.py`` computes; the
rows and the data are pinned by ``fixtures/docs-page-conformance/``. A project overrides a page
by dropping a same-named template under its templates directory. The generator reads the loaded
model and nothing else.
"""
from __future__ import annotations

from typing import Any

from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.render.doc_pages import doc_provider, render_doc_page
from metaobjects.render.verify import Provider

from ..runtime.docs_requirements import (
    REQUIREMENTS_PAGE_REF,
    REQUIREMENTS_TOON_REF,
    requirement_rows,
    requirements_ledger_data,
    requirements_toon_data,
)

MARKDOWN_FILENAME = "requirements.md"
TOON_FILENAME = "requirements.toon"


class RequirementsGenerator:
    """Writes ``requirements.md`` and ``requirements.toon`` for the run's loaded model."""

    name = "requirements"

    def __init__(self, template_root: str | None = None, provider: Provider | None = None) -> None:
        self._provider = provider if provider is not None else doc_provider(template_root)
        #: A project's templates directory is part of the run's skip key (``cli.py`` hashes it).
        self.template_root = template_root

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        if ctx.loaded_root is None:
            return []
        rows = requirement_rows(ctx.loaded_root, ctx.in_ledger)
        if not rows:
            return []
        return [
            EmittedFile(
                path=MARKDOWN_FILENAME,
                content=render_doc_page(
                    REQUIREMENTS_PAGE_REF, requirements_ledger_data(rows), self._provider, MARKDOWN_FILENAME
                ),
            ),
            EmittedFile(
                path=TOON_FILENAME,
                content=render_doc_page(
                    REQUIREMENTS_TOON_REF, requirements_toon_data(rows), self._provider, TOON_FILENAME
                ),
            ),
        ]


def requirements_generator(ctx: Any) -> Generator:
    """The registry's ``source=``, and so the symbol an ejected copy is wired by. It takes the
    build context and reads the templates directory the run resolved."""
    return RequirementsGenerator(template_root=getattr(ctx, "template_root", None))
