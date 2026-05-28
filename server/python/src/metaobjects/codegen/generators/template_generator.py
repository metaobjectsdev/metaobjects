"""template_generator() — Python port of the TS rc.12 factory.

Walks the loaded MetaRoot -> renders shared Mustache templates via the
metaobjects.render engine -> returns EmittedFile[]. Same Generator Protocol
as the per-entity hand-coded generators; just adds the "Mustache template"
+ "walk that yields a data dict per output" primitives.

Design: spec/design-docs/2026-05-28-cross-port-template-generator.md.
Cross-port byte-equivalence verified via fixtures/render-conformance/template-generator/.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Sequence

from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.render import escapers
from metaobjects.render.renderer import RenderRequest, render
from metaobjects.render.verify import Provider


@dataclass
class _TemplateGenerator:
    name: str
    template: str
    walk: Callable[[Any], Sequence[dict]]
    provider: Provider
    format: str = escapers.FORMAT_TEXT

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        walk_results: Iterable[dict] = self.walk(ctx.loaded_root)
        files: list[EmittedFile] = []
        for entry in walk_results:
            content = render(
                RenderRequest(
                    payload=entry["data"],
                    provider=self.provider,
                    ref=self.template,
                    format=self.format,
                )
            )
            files.append(EmittedFile(path=entry["output_path"], content=content))
        return files


def template_generator(
    *,
    name: str,
    template: str,
    walk: Callable[[Any], Sequence[dict]],
    provider: Provider,
    format: str = escapers.FORMAT_TEXT,
) -> Generator:
    """Build a Generator that renders a Mustache template per walk entry.

    Args:
        name: kebab-case identifier; surfaces in diagnostics.
        template: ref resolved by the provider (e.g. "custom/hello").
        walk: callback that takes the loaded MetaRoot and returns a list of
            dicts shaped {"data": <payload>, "output_path": <relative path>}.
        provider: ref-resolver for the template.
        format: render format ("text", "html", "markdown", ...). Defaults to text.
    """
    return _TemplateGenerator(
        name=name,
        template=template,
        walk=walk,
        provider=provider,
        format=format,
    )
