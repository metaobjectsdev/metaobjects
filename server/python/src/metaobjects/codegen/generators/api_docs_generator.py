"""``api-docs`` — the Python SDK api reference (the ``api/python`` surface of the cross-port
SDK-docs contract): one page per entity, value object, projection, served report and
template, an index, and the agent-facing ``AGENT-API.md`` page.

An ordinary entry in a target's ``generators`` in ``metaobjects.config.yaml``, run by
``metaobjects gen`` (ADR-0034 Amendment 9). Its pages land under that target's ``outDir``,
prefixed with the api subdirectory. Its options are the top-level ``apiDocs`` block
(``apiSubDir``, ``projectName``, ``modelBaseUrl``), which reaches it through the build context.

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

from typing import Any

from metaobjects.codegen.generator import DEFAULT_API_SUBDIR, EmittedFile, GenContext, Generator

from ..runtime.api_docs_builder import PythonApiModelBuilder
from ..runtime.api_docs_paths import Layout, doc_page_output_path, model_cross_href
from ..runtime.api_docs_renderer import PythonApiDocsRenderer


class ApiDocsGenerator:
    """Writes the api reference pages for the run's loaded model."""

    name = "api-docs"

    def __init__(
        self,
        api_subdir: str = DEFAULT_API_SUBDIR,
        project_name: str = "project",
        model_base_url: str | None = None,
    ) -> None:
        #: Where under the target's ``outDir`` the pages land.
        self.api_subdir = api_subdir
        #: The label the pages carry in their header.
        self.project_name = project_name
        #: When set, the base URL the model back-links federate to (``None`` = relative links).
        self.model_base_url = model_base_url

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        if ctx.loaded_root is None:
            return []
        model = PythonApiModelBuilder(ctx.config.api_prefix).build(ctx.loaded_root, self.project_name)
        renderer = PythonApiDocsRenderer()
        layout = Layout.PACKAGE

        def page(path: str, content: str) -> EmittedFile:
            return EmittedFile(path=f"{self.api_subdir}/{path}", content=content)

        files: list[EmittedFile] = []
        for unit in model.units:
            page_path = doc_page_output_path(layout, unit.package, unit.node)
            # The model page is written by no Python generator, so a relative link would be
            # dead: link only when `modelBaseUrl` says where the model pages are published.
            href = (
                model_cross_href(f"{self.api_subdir}/{page_path}", page_path, self.model_base_url)
                if self.model_base_url
                else None
            )
            files.append(page(page_path, renderer.render_unit_page(unit, href)))
        files.append(page("README.md", renderer.render_index(model, layout)))
        files.append(page("AGENT-API.md", renderer.render_agent_api(model)))
        return files


def api_docs_generator(ctx: Any) -> Generator:
    """The registry's ``source=``, and so the symbol an ejected copy is wired by.

    It takes the build context (one required positional parameter, which is what
    ``eject.build_owned`` passes the context to) and reads the ``apiDocs`` config block the
    context carries. With no block the defaults apply.
    """
    options = getattr(ctx, "api_docs", None)
    if options is None:
        return ApiDocsGenerator()
    return ApiDocsGenerator(
        api_subdir=options.api_subdir,
        project_name=options.project_name,
        model_base_url=options.model_base_url,
    )
