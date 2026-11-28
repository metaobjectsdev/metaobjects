"""``metamodel-docs`` — the reference of the built-in metamodel: ``INDEX.md``, ``providers.md`` and
one ``types/<family>.md`` per type family, under ``metamodel/`` of its target.

An ordinary entry in a target's ``generators`` (the ``docs`` target by convention), run by
``metaobjects gen``. It reads no model objects: the pages describe the vocabulary this build
registers, from the registry vocabulary manifest and the embedded provider definitions.

Each page is the shared Mustache template (``templates/metamodel/``, bundled with the package)
fed the data the builder in ``codegen/runtime/docs_metamodel.py`` computes; the data and the
pages are pinned by ``fixtures/metamodel-docs/``. A project overrides a page by dropping a
same-named template under its templates directory.
"""
from __future__ import annotations

import json

from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.core_types import core_providers
from metaobjects.provider import compose_registry
from metaobjects.registry_manifest import build_registry_manifest
from metaobjects.render.doc_pages import BUNDLED_TEMPLATES_DIR, doc_provider, render_doc_page
from metaobjects.render.verify import Provider

from ..runtime.docs_metamodel import (
    PROVIDER_DESCRIPTIONS_REF,
    embedded_definitions,
    metamodel_docs_pages,
)

DEFAULT_SUB_DIR = "metamodel"


def _provider_descriptions() -> dict[str, str]:
    """The bundled ``metamodel/provider-descriptions.json``."""
    descriptions: dict[str, str] = json.loads((BUNDLED_TEMPLATES_DIR / PROVIDER_DESCRIPTIONS_REF).read_text(encoding="utf-8"))
    return descriptions


class MetamodelDocsGenerator:
    """Writes the metamodel reference pages."""

    name = "metamodel-docs"

    def __init__(
        self,
        template_root: str | None = None,
        provider: Provider | None = None,
        sub_dir: str = DEFAULT_SUB_DIR,
    ) -> None:
        self._provider = provider if provider is not None else doc_provider(template_root)
        #: A project's templates directory is part of the run's skip key (``cli.py`` hashes it).
        self.template_root = template_root
        self.sub_dir = sub_dir.strip("/")

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        manifest = build_registry_manifest(compose_registry(core_providers))
        pages = metamodel_docs_pages(manifest, embedded_definitions(), _provider_descriptions())
        prefix = f"{self.sub_dir}/" if self.sub_dir else ""
        return [
            EmittedFile(
                path=prefix + page.path,
                content=render_doc_page(page.template, page.data, self._provider, prefix + page.path),
            )
            for page in pages
        ]


def metamodel_docs_generator(template_root: str | None = None, sub_dir: str = DEFAULT_SUB_DIR) -> Generator:
    """The registry's ``source=``, and so the symbol an ejected copy is wired by. It takes the
    templates directory the run resolved and the entry's ``subDir`` option as ``sub_dir``."""
    return MetamodelDocsGenerator(template_root=template_root, sub_dir=sub_dir)
