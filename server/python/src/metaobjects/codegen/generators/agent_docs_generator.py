"""``agent-docs`` — pages written for a coding agent working in the project.

In Python this writes two pages under ``agent/``: ``agent/requirements.md`` (the node index, the
statements and the embedded ledger, read before adding a capability) and ``agent/schema.md``
(the MODEL-ONLY schema page: the tables, columns, keys, views, relationships and enums the model
declares, read before touching persistence; no SQL type, default, index, check or constraint
name, which only the TypeScript page, written from the expected schema, carries).
``agent/ui.md`` stays TypeScript-only: Python generates no client UI to describe.

Each page is a shared Mustache template (``templates/agent/`` and ``templates/requirements/``,
bundled with the package) fed the data the builders in ``codegen/runtime/docs_requirements.py``
and ``codegen/runtime/docs_schema.py`` compute from the loaded model, pinned by
``fixtures/docs-page-conformance/``. A page with nothing to describe is no file. A project
overrides a page by dropping a same-named template under its templates directory.
"""
from __future__ import annotations

from typing import Any

from metaobjects.config.neutral_config import chose_migrate_dialect
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.render.doc_pages import doc_provider, end_with_one_newline, render_doc_page
from metaobjects.render.verify import Provider

from ..runtime.docs_requirements import (
    AGENT_REQUIREMENTS_PAGE_REF,
    REQUIREMENTS_PAGE_REF,
    agent_requirements_page_data,
)
from ..runtime.docs_schema import (
    AGENT_SCHEMA_PAGE_REF,
    agent_schema_page_data,
    schema_rows,
)

DEFAULT_AGENT_DIR = "agent"


class AgentDocsGenerator:
    """Writes ``agent/schema.md`` and ``agent/requirements.md`` for the run's loaded model."""

    name = "agent-docs"

    def __init__(
        self,
        sub_dir: str = DEFAULT_AGENT_DIR,
        template_root: str | None = None,
        provider: Provider | None = None,
    ) -> None:
        self._dir = sub_dir.rstrip("/")
        self._provider = provider if provider is not None else doc_provider(template_root)
        self.template_root = template_root

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        if ctx.loaded_root is None:
            return []
        root = ctx.loaded_root
        files: list[EmittedFile] = []

        # `.metaobjects/config.json` is already part of the run's skip key (cli `_skip_identity`).
        has_migrate = chose_migrate_dialect(ctx.config.project_root)
        schema_data = agent_schema_page_data(root, schema_rows(root), has_migrate)
        if schema_data is not None:
            path = f"{self._dir}/schema.md"
            page = render_doc_page(AGENT_SCHEMA_PAGE_REF, schema_data, self._provider, path)
            files.append(EmittedFile(path=path, content=end_with_one_newline(page)))

        def render_ledger(data: dict[str, Any]) -> str:
            return render_doc_page(REQUIREMENTS_PAGE_REF, data, self._provider, "requirements.md")

        requirements = agent_requirements_page_data(root, ctx.in_ledger, render_ledger)
        if requirements is not None:
            path = f"{self._dir}/requirements.md"
            files.append(
                EmittedFile(
                    path=path,
                    content=render_doc_page(AGENT_REQUIREMENTS_PAGE_REF, requirements, self._provider, path),
                )
            )
        return files


def agent_docs_generator(ctx: Any) -> Generator:
    """The registry's ``source=``, and so the symbol an ejected copy is wired by."""
    return AgentDocsGenerator(template_root=getattr(ctx, "template_root", None))
