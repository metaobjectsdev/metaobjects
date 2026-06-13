"""Python native SDK / API-reference docs (the ``api/python`` surface).

Tier-1, idiomatic per-language reference for the generated Python SDK (Pydantic
model / FastAPI routes / repository ``Protocol`` data-access / validation /
extractor / render helper / payload / output-format prompt / output parser /
filter allowlist). Accurate-by-construction: every documented symbol name comes
from the :mod:`metaobjects.apidocs.naming` seam — the SAME seam the real
generators delegate to — so docs can never claim a name the generators do not
emit. Distinct from the model docs (Tier-2, neutral, TS-owned). See
``docs/superpowers/specs/2026-06-13-cross-port-sdk-docs-conformance-design.md``.

The builder / renderer symbols are exposed lazily (via :pep:`562` module
``__getattr__``) so that a generator importing the lightweight
:mod:`metaobjects.apidocs.naming` seam does NOT pull in the builder (which imports
those same generators) — that would be a circular import at module-init time.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

# Path math is leaf-level (no generator imports) — safe to expose eagerly.
from metaobjects.apidocs.paths import (
    Layout,
    doc_page_output_path,
    model_cross_href,
    package_to_path,
    surface_cross_href,
)

if TYPE_CHECKING:  # pragma: no cover - import-time only for type checkers
    from metaobjects.apidocs.api_model import (
        ApiModel,
        ApiSymbol,
        ApiSymbolKind,
        ApiUnit,
        FieldShape,
        UnitExample,
    )
    from metaobjects.apidocs.builder import PythonApiModelBuilder, build_api_model
    from metaobjects.apidocs.renderer import (
        PythonApiDocsRenderer,
        render_agent_api,
        render_index,
        render_unit_page,
    )

# Lazily-resolved exports → their defining submodule.
_LAZY: dict[str, str] = {
    "ApiModel": "api_model",
    "ApiSymbol": "api_model",
    "ApiSymbolKind": "api_model",
    "ApiUnit": "api_model",
    "FieldShape": "api_model",
    "UnitExample": "api_model",
    "PythonApiModelBuilder": "builder",
    "build_api_model": "builder",
    "PythonApiDocsRenderer": "renderer",
    "render_unit_page": "renderer",
    "render_index": "renderer",
    "render_agent_api": "renderer",
}

__all__ = [
    "ApiModel",
    "ApiSymbol",
    "ApiSymbolKind",
    "ApiUnit",
    "FieldShape",
    "UnitExample",
    "PythonApiModelBuilder",
    "build_api_model",
    "PythonApiDocsRenderer",
    "render_unit_page",
    "render_index",
    "render_agent_api",
    "Layout",
    "doc_page_output_path",
    "model_cross_href",
    "package_to_path",
    "surface_cross_href",
]


def __getattr__(name: str) -> Any:
    submodule = _LAZY.get(name)
    if submodule is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib

    mod = importlib.import_module(f"{__name__}.{submodule}")
    return getattr(mod, name)
