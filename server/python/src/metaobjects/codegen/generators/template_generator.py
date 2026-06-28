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
from metaobjects.codegen.template_codegen.output_pattern import expand_output_pattern
from metaobjects.codegen.template_codegen.template_data import (
    build_entity_template_data,
    build_model_template_data,
    build_package_template_data,
    bare_name,
    is_concrete,
    package_of,
)
from metaobjects.render import escapers
from metaobjects.render.renderer import RenderRequest, render
from metaobjects.render.verify import Provider

#: The three built-in walk scopes (SP-1 §3.1).
SCOPES = ("perEntity", "perPackage", "perModel")


def _scope_walk(scope: str, pattern: str) -> Callable[[Any], list[dict]]:
    """Derive a walk from a built-in scope + output pattern. Each scope yields the
    neutral data dict for its unit and names the file via the pattern."""

    def walk(root: Any) -> list[dict]:
        from metaobjects.meta.core.object.meta_object import MetaObject

        objects = [c for c in root.children() if isinstance(c, MetaObject)]
        concrete = [o for o in objects if is_concrete(o)]
        if scope == "perEntity":
            return [
                {
                    "data": build_entity_template_data(o),
                    "output_path": expand_output_pattern(pattern, bare_name(o), package_of(o)),
                }
                for o in concrete
            ]
        if scope == "perPackage":
            by_pkg: dict[str, list[Any]] = {}
            for o in concrete:
                by_pkg.setdefault(package_of(o), []).append(o)
            return [
                {
                    "data": build_package_template_data(pkg, by_pkg[pkg]),
                    "output_path": expand_output_pattern(pattern, None, pkg),
                }
                for pkg in sorted(by_pkg)
            ]
        # perModel — one file over the whole model.
        return [
            {
                "data": build_model_template_data(objects),
                "output_path": expand_output_pattern(pattern, None, None),
            }
        ]

    return walk


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
    provider: Provider,
    walk: Callable[[Any], Sequence[dict]] | None = None,
    scope: str | None = None,
    output_pattern: str | None = None,
    format: str = escapers.FORMAT_TEXT,
) -> Generator:
    """Build a Generator that renders a Mustache template per walk entry.

    Provide exactly one of ``walk`` (the power-user escape hatch) or
    (``scope`` + ``output_pattern``) — the declarative built-in walk.

    Args:
        name: kebab-case identifier; surfaces in diagnostics.
        template: ref resolved by the provider (e.g. "custom/hello").
        provider: ref-resolver for the template.
        walk: callback taking the loaded MetaRoot, returning dicts shaped
            {"data": <payload>, "output_path": <relative path>}.
        scope: built-in walk scope (perEntity/perPackage/perModel).
        output_pattern: output path pattern for the built-in scope walk.
        format: render format ("text", "html", "markdown", ...). Defaults to text.
    """
    has_walk = walk is not None
    has_scope = scope is not None
    if has_walk == has_scope:
        raise ValueError(
            f"template_generator({name}): provide exactly one of `walk` or "
            "(`scope` + `output_pattern`)"
        )
    if has_scope and not output_pattern:
        raise ValueError(f"template_generator({name}): `scope` requires `output_pattern`")
    resolved_walk = walk if has_walk else _scope_walk(scope, output_pattern)  # type: ignore[arg-type]
    return _TemplateGenerator(
        name=name,
        template=template,
        walk=resolved_walk,
        provider=provider,
        format=format,
    )
