"""``api-docs`` — the Python SDK api reference (the ``api/python`` surface of the cross-port
SDK-docs contract): one page per entity, value object, projection, served report and
template, an index, and the agent-facing ``AGENT-API.md`` page.

Run by ``metaobjects docs``, not by ``metaobjects gen``: it carries ``docs_surface``, which
``gen`` skips. Its files land under the docs output directory, prefixed with the api
subdirectory the run names (``ctx.docs``).

The page IR, the builder that decides which units and symbols get a page, the renderer and
the page-path math live beside this module in ``codegen/runtime/`` and are handed over with
it: ``metaobjects eject api-docs`` copies all of them, so the copy owns every line that
writes a page. What each page says a generator emits for comes from
``..runtime.shared_predicates`` — the module the router and filter-allowlist generators read
their gates from. An owned ``api-docs`` and an owned ``routes`` therefore read ONE owned copy
of those predicates, and the reference describes the code the project's own generators emit.
The naming seam (:mod:`metaobjects.apidocs.naming`) is the engine: the same names the
generators emit under.
"""
from __future__ import annotations

from metaobjects.codegen.generator import (
    DOCS_SURFACE_API,
    DocsRunFacts,
    EmittedFile,
    GenContext,
    Generator,
)

from ..runtime.api_docs_builder import PythonApiModelBuilder
from ..runtime.api_docs_paths import Layout, doc_page_output_path, model_cross_href
from ..runtime.api_docs_renderer import PythonApiDocsRenderer


class ApiDocsGenerator:
    """Writes the api reference pages for the run's loaded model."""

    name = "api-docs"
    #: Which docs surface this generator takes over (see ``metaobjects docs``).
    docs_surface = DOCS_SURFACE_API

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        if ctx.loaded_root is None:
            return []
        # A docs run supplies the facts. A caller that runs this generator directly, as a
        # registry-wide probe does, gets the defaults and a neutral project label.
        facts = ctx.docs or DocsRunFacts()
        model = PythonApiModelBuilder().build(ctx.loaded_root, facts.project)
        renderer = PythonApiDocsRenderer()
        layout = Layout.PACKAGE

        def page(path: str, content: str) -> EmittedFile:
            return EmittedFile(path=f"{facts.api_subdir}/{path}", content=content)

        files: list[EmittedFile] = []
        for unit in model.units:
            page_path = doc_page_output_path(layout, unit.package, unit.node)
            href = model_cross_href(
                f"{facts.api_subdir}/{page_path}", page_path, facts.model_base_url
            )
            files.append(page(page_path, renderer.render_unit_page(unit, href)))
        files.append(page("README.md", renderer.render_index(model, layout)))
        files.append(page("AGENT-API.md", renderer.render_agent_api(model)))
        return files


def api_docs_generator() -> Generator:
    """Generator factory: the api reference ``metaobjects docs`` writes."""
    return ApiDocsGenerator()
