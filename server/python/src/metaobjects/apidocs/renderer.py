"""Renders the :class:`ApiModel` IR into Python-idiomatic api-doc markdown.

One IR, three forms — all derived from the SAME model, never re-derived:

* :func:`render_unit_page`  — a per-unit HUMAN page (entity OR template), symbols
  grouped into ordered sections + the ``**Model / metadata:**`` back-link.
* :func:`render_index`      — the consolidated index (README.md), one bullet per unit.
* :func:`render_agent_api`  — the token-frugal AGENT form (AGENT-API.md), symbols
  grouped under their import line.

PRESENTATION ONLY: every symbol name comes from the IR (which keys off the naming
seam) and every path comes from :mod:`metaobjects.apidocs.paths` — the renderer never
re-derives a name or a path. The section order + headings + the back-link literal
mirror the Java / C# renderers so the polyglot doc tree coheres.
"""
from __future__ import annotations

from metaobjects.apidocs.api_model import ApiModel, ApiSymbolKind, ApiUnit
from metaobjects.apidocs.paths import Layout, doc_page_output_path, surface_cross_href

# Canonical section order per kind (a unit renders only the kinds it carries).
_KIND_ORDER: tuple[ApiSymbolKind, ...] = (
    ApiSymbolKind.MODEL,
    ApiSymbolKind.DATA_ACCESS,
    ApiSymbolKind.REST,
    ApiSymbolKind.VALIDATION,
    ApiSymbolKind.EXTRACTOR,
    ApiSymbolKind.RENDER,
    ApiSymbolKind.PAYLOAD,
    ApiSymbolKind.PROMPT,
    ApiSymbolKind.OUTPUT_PARSER,
    ApiSymbolKind.FILTER,
)

_HEADINGS: dict[ApiSymbolKind, str] = {
    ApiSymbolKind.MODEL: "Model",
    ApiSymbolKind.DATA_ACCESS: "Data access",
    ApiSymbolKind.REST: "REST",
    ApiSymbolKind.VALIDATION: "Validation",
    ApiSymbolKind.EXTRACTOR: "Extractor",
    ApiSymbolKind.RENDER: "Render",
    ApiSymbolKind.PAYLOAD: "Payload",
    ApiSymbolKind.PROMPT: "Prompt",
    ApiSymbolKind.OUTPUT_PARSER: "Output parser",
    ApiSymbolKind.FILTER: "Filter",
}

_SUMMARY_LABELS: dict[ApiSymbolKind, str] = {
    ApiSymbolKind.MODEL: "model",
    ApiSymbolKind.DATA_ACCESS: "data access",
    ApiSymbolKind.REST: "REST",
    ApiSymbolKind.VALIDATION: "validation",
    ApiSymbolKind.EXTRACTOR: "extractor",
    ApiSymbolKind.RENDER: "render",
    ApiSymbolKind.PAYLOAD: "payload",
    ApiSymbolKind.PROMPT: "prompt",
    ApiSymbolKind.OUTPUT_PARSER: "output parser",
    ApiSymbolKind.FILTER: "filter",
}


def _md_cell(text: str) -> str:
    return text.replace("|", "\\|")


def render_unit_page(unit: ApiUnit, model_href: str | None) -> str:
    """Render one per-unit human reference page. *model_href* (when non-empty) is a
    pre-computed relative href back to this unit's model/metadata page — the caller
    derives it via :func:`metaobjects.apidocs.paths.model_cross_href`; the renderer
    only places it (as the contract ``**Model / metadata:**`` back-link)."""
    out: list[str] = [f"# {unit.node} API\n"]
    if model_href:
        out.append(f"\n**Model / metadata:** [{unit.node}]({model_href})\n")
    out.append(
        "\n> Import paths are relative to the generated package; add it to your "
        "Python path.\n"
    )

    for kind in _KIND_ORDER:
        syms = [s for s in unit.symbols if s.kind == kind]
        if not syms:
            continue
        out.append(f"\n## {_HEADINGS[kind]}\n")
        for sym in syms:
            out.append(f"\n### `{sym.signature}`\n")
            out.append(f"\n{sym.usage}\n")
            out.append(f"\n```python\n{sym.module}\n```\n")
            if sym.returns:
                out.append(f"\nReturns: {sym.returns}\n")
            if sym.fields:
                out.append("\n| Field | Type | Required | Notes |\n|---|---|---|---|\n")
                for f in sym.fields:
                    required = "no" if f.optional else "yes"
                    out.append(
                        f"| `{f.name}` | `{_md_cell(f.type)}` | {required} | "
                        f"{_md_cell(f.note or '')} |\n"
                    )
    return "".join(out)


def render_index(model: ApiModel, layout: Layout) -> str:
    """Render the consolidated api index (README.md): one bullet per unit, entities/
    values vs templates. Each unit's href is the relative link from the index to the
    unit's page in the given *layout*."""
    entities = sorted(
        (u for u in model.units if u.kind != "template"), key=lambda u: u.node
    )
    templates = sorted(
        (u for u in model.units if u.kind == "template"), key=lambda u: u.node
    )

    out: list[str] = [
        "# API Reference\n\nGenerated public API surface, one page per entity and "
        "output template.\n"
    ]
    if entities:
        out.append("\n## Entities\n\n")
        for u in entities:
            out.append(_index_row(u, layout))
    if templates:
        out.append("\n## Templates\n\n")
        for u in templates:
            out.append(_index_row(u, layout))
    return "".join(out)


def _index_row(unit: ApiUnit, layout: Layout) -> str:
    href = surface_cross_href(
        "README.md", doc_page_output_path(layout, unit.package, unit.node)
    )
    return (
        f"- [{unit.node}]({href}) — {_summary(unit)} "
        f"({len(unit.symbols)} symbols)\n"
    )


def _summary(unit: ApiUnit) -> str:
    parts: list[str] = []
    for kind in _KIND_ORDER:
        n = sum(1 for s in unit.symbols if s.kind == kind)
        if n == 0:
            continue
        label = _SUMMARY_LABELS[kind]
        parts.append(label if n == 1 else f"{n} {label}")
    return ", ".join(parts) if parts else "no public symbols"


def render_agent_api(model: ApiModel) -> str:
    """Render the condensed agent/LLM form (AGENT-API.md): per unit, symbols grouped
    under a single import-line header then one compact ``` `signature` — usage ``` line
    each. NO prose / field-tables (token budget). Units + symbols keep their IR order."""
    out: list[str] = [
        f"# Agent API Reference\n\nGenerated Python API reference for "
        f"{model.project}; call these exactly as written. Import paths are relative "
        "to the generated package.\n"
    ]
    for unit in model.units:
        if not unit.symbols:
            continue
        out.append(f"\n## {unit.node}\n")
        groups: dict[str, list[str]] = {}
        order: list[str] = []
        for s in unit.symbols:
            if s.module not in groups:
                groups[s.module] = []
                order.append(s.module)
            groups[s.module].append(f"- `{s.signature}` — {s.usage}\n")
        for module in order:
            out.append(f"\n`{module}`\n")
            out.extend(groups[module])
    return "".join(out)


class PythonApiDocsRenderer:
    """Object wrapper around the module-level render functions (parity with the
    Java / C# renderer classes; the functions are the canonical entry points)."""

    def render_unit_page(self, unit: ApiUnit, model_href: str | None) -> str:
        return render_unit_page(unit, model_href)

    def render_index(self, model: ApiModel, layout: Layout) -> str:
        return render_index(model, layout)

    def render_agent_api(self, model: ApiModel) -> str:
        return render_agent_api(model)
