"""The Python codegen NAMING SEAM — the single source of truth for every
generated identifier the api-docs builder documents.

This mirrors the Java ``SpringNaming`` / C# ``CSharpNaming`` pattern: the real
generators delegate their name computation here, and the
:class:`~metaobjects.apidocs.builder.PythonApiModelBuilder` enumerates symbols by
calling the SAME functions. So the documented name can never drift from the
emitted name — they are computed once, in one place.

Behaviour-preserving: each function reproduces exactly what the corresponding
generator used to compute inline (``_snake_case`` / ``_plural_lowercase`` /
``<Name>Repository`` / ``<ENTITY>_FILTER_FIELDS`` / ``parse_<snake>`` /
``render_<snake>`` / ``render_<snake>_format`` / ``extract_<snake>`` …). The
payload-class / payload-module names already lived in
``payload_vo_generator`` (``payload_class_name`` / ``payload_module_name``); this
seam re-exports them so the builder has one import surface.
"""
from __future__ import annotations

from metaobjects.codegen.generators.payload_vo_generator import (
    payload_class_name,
    payload_module_name,
)

__all__ = [
    "snake_case",
    "plural_lowercase",
    "model_class_name",
    "router_module_name",
    "repository_class_name",
    "filter_allowlist_module_name",
    "filter_fields_const",
    "filter_ops_const",
    "route_path",
    "pk_param",
    "payload_class_name",
    "payload_module_name",
    "render_helper_fn",
    "output_prompt_fn",
    "output_parser_fn",
    "extractor_fn",
]


def snake_case(name: str) -> str:
    """``Author`` → ``author``; ``AuthorBrief`` → ``author_brief``.

    Trivial PascalCase → snake_case (no acronym handling) — the canonical form
    every sibling generator computes inline. Owning it here keeps the file name
    (``author_router.py``), the path-param (``/{author_id}``), and the documented
    names in lock-step."""
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def plural_lowercase(name: str) -> str:
    """``Author`` → ``authors``. Cross-port-aligned trivial pluralization."""
    return name.lower() + "s"


def model_class_name(obj_name: str) -> str:
    """The emitted Pydantic model class name — the object's own short name."""
    return obj_name


def router_module_name(obj_name: str) -> str:
    """``Author`` → ``author_router`` (the emitted FastAPI router module, no ``.py``)."""
    return f"{snake_case(obj_name)}_router"


def repository_class_name(obj_name: str) -> str:
    """``Author`` → ``AuthorRepository`` (the consumer-implemented repo ``Protocol``)."""
    return f"{obj_name}Repository"


def filter_allowlist_module_name(obj_name: str) -> str:
    """``Author`` → ``author_filter_allowlist`` (the emitted allowlist module)."""
    return f"{snake_case(obj_name)}_filter_allowlist"


def filter_fields_const(obj_name: str) -> str:
    """``Author`` → ``AUTHOR_FILTER_FIELDS`` (the filterable-field frozenset const)."""
    return f"{obj_name.upper()}_FILTER_FIELDS"


def filter_ops_const(obj_name: str) -> str:
    """``Author`` → ``AUTHOR_FILTER_OPS_BY_FIELD`` (the per-field op-vocabulary const)."""
    return f"{obj_name.upper()}_FILTER_OPS_BY_FIELD"


def route_path(obj_name: str) -> str:
    """The default REST base segment — the entity name pluralized + lowercased
    (cross-port grammar; e.g. ``Author`` → ``authors``)."""
    return plural_lowercase(obj_name)


def pk_param(obj_name: str) -> str:
    """``Author`` → ``author_id`` (the path-parameter name on item routes)."""
    return f"{snake_case(obj_name)}_id"


def render_helper_fn(template_name: str) -> str:
    """``OrderSummary`` → ``render_order_summary`` (the typed render helper fn)."""
    return f"render_{snake_case(template_name)}"


def output_prompt_fn(template_name: str) -> str:
    """``OrderSummary`` → ``render_order_summary_format`` (the output-format prompt fn)."""
    return f"render_{snake_case(template_name)}_format"


def output_parser_fn(template_name: str) -> str:
    """``OrderSummary`` → ``parse_order_summary`` (the strict output parser fn)."""
    return f"parse_{snake_case(template_name)}"


def extractor_fn(template_name: str) -> str:
    """``OrderSummary`` → ``extract_order_summary`` (the strict extractor fn)."""
    return f"extract_{snake_case(template_name)}"
