"""Render a Jinja body (ADR-0061) with jinja2, through the same provider and the same
format-driven escapers as the Mustache path.

Output matches the TypeScript port (nunjucks) for the shared Jinja vocabulary — gated by
``fixtures/jinja-render-conformance/``. Three settings make that hold:

* every ``{{ … }}`` value is printed the way the Mustache renderer prints it (``True`` →
  ``true``, ``1.0`` → ``1``, ``None`` → empty) and then escaped for the request's format;
  ``| safe`` marks a value as already-escaped and bypasses the escaper, as in nunjucks;
* a trailing newline is kept (jinja2 drops it by default; nunjucks and Mustache keep it);
* the static template graph is checked first, so a cycle or a missing template fails with
  the Mustache path's messages (``partial cycle:``, ``unresolved partial:``).
"""

from __future__ import annotations

from typing import Any

from . import escapers
from .jinja_verify import jinja2_module, parse_jinja, ref_of_template_name
from .renderer import _stringify
from .verify import MAX_DEPTH, Provider


class JinjaRenderError(Exception):
    """A Jinja render failed before or during template evaluation."""


def _normalize(payload: Any) -> Any:
    """A Pydantic model (a generated payload model, ADR-0056) is rendered as its JSON-mode
    dump, as the Mustache path does: field names as keys, enums as their wire values."""
    dump = getattr(payload, "model_dump", None)
    if callable(dump) and not isinstance(payload, type):
        return dump(mode="json")
    return payload


def _template_refs(text: str) -> list[tuple[str, bool]]:
    jinja2 = jinja2_module()
    nodes = jinja2.nodes
    out: list[tuple[str, bool]] = []
    for n in parse_jinja(text).find_all((nodes.Include, nodes.Import, nodes.FromImport, nodes.Extends)):
        t = n.template
        if isinstance(t, nodes.Const) and isinstance(t.value, str):
            out.append((ref_of_template_name(t.value), bool(getattr(n, "ignore_missing", False))))
    return out


def _check_template_graph(text: str, provider: Provider, path: list[str]) -> None:
    for ref, optional in _template_refs(text):
        if ref in path:
            raise JinjaRenderError(f"partial cycle: {' -> '.join([*path, ref])}")
        if len(path) >= MAX_DEPTH:
            raise JinjaRenderError(f"partial depth exceeded {MAX_DEPTH}: {ref}")
        body = provider.resolve(ref)
        if body is None:
            if optional:
                continue
            raise JinjaRenderError(f"unresolved partial: {ref}")
        _check_template_graph(body, provider, [*path, ref])


def render_jinja(body: str, ref: str | None, payload: Any, provider: Provider, format_: str) -> str:
    """Render Jinja ``body`` (whose own ref, when it has one, is ``ref``) against ``payload``."""
    jinja2 = jinja2_module()
    from markupsafe import Markup

    try:
        _check_template_graph(body, provider, [ref] if ref is not None else [])
    except jinja2.TemplateSyntaxError as e:
        raise JinjaRenderError(f"template syntax error: {e.message}") from e

    def finalize(value: Any) -> str:
        if isinstance(value, Markup):
            return str(value)
        if value is None or isinstance(value, jinja2.Undefined):
            return ""
        return escapers.escape(format_, _stringify(value))

    def load(name: str) -> tuple[str, None, Any] | None:
        src = provider.resolve(ref_of_template_name(name))
        return None if src is None else (src, None, lambda: False)

    env = jinja2.Environment(
        loader=jinja2.FunctionLoader(load),
        autoescape=False,
        keep_trailing_newline=True,
        finalize=finalize,
        undefined=jinja2.Undefined,
    )
    context = _normalize(payload)
    if not isinstance(context, dict):
        context = {}
    return str(env.from_string(body).render(**context))


__all__ = ["JinjaRenderError", "render_jinja"]
