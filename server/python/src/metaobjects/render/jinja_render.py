"""Render a Jinja body (ADR-0061) with jinja2, through the same provider and the same
format-driven escapers as the Mustache path.

Output matches the TypeScript port (nunjucks) for the shared Jinja vocabulary — gated by
``fixtures/jinja-render-conformance/``. These settings make that hold:

* every ``{{ … }}`` value is printed the way the Mustache renderer prints it (``True`` →
  ``true``, ``1.0`` → ``1``, ``None`` → empty) and then escaped for the request's format;
  ``| safe`` marks a value as already-escaped and bypasses the escaper, and ``| escape`` /
  ``| e`` / ``| forceescape`` escape with that same escaper, as in nunjucks;
* what a macro, a ``call`` block or a block ``set`` renders is already escaped, so printing
  it does not escape it again (nunjucks returns those as safe strings);
* a lookup on a missing key renders empty however deep it chains (``v.x.y``), as in
  nunjucks; every engine failure surfaces as ``JinjaRenderError``;
* a trailing newline is kept (jinja2 drops it by default; nunjucks and Mustache keep it);
* the static template graph is checked first, so a cycle or a missing template fails with
  the Mustache path's messages (``partial cycle:``, ``unresolved partial:``).
"""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping
from typing import Any

from . import escapers
from .engine import TEMPLATE_ENGINE_JINJA, partial_engine_message, partial_engine_mismatch
from .jinja_verify import jinja2_module, parse_jinja, ref_of_template_name
from .renderer import _stringify
from .verify import MAX_DEPTH, Provider


class JinjaRenderError(Exception):
    """A Jinja render failed before or during template evaluation."""


class _Rendered(str):
    """Text a template already rendered (a macro, a ``call`` body, a block ``set``): its
    values were escaped as they were printed, so printing it again must not escape twice."""


def _concat(parts: Any) -> _Rendered:
    return _Rendered("".join(parts))


def _context(payload: Any) -> dict[str, Any]:
    """The template's top-level names. A Pydantic model (a generated payload model,
    ADR-0056) is its JSON-mode dump, as on the Mustache path: field names as keys, enums as
    their wire values. A mapping, a dataclass or a plain object is read by its fields;
    anything else has no names a template could address, and is refused."""
    dump = getattr(payload, "model_dump", None)
    if callable(dump) and not isinstance(payload, type):
        payload = dump(mode="json")
    if isinstance(payload, Mapping):
        return dict(payload)
    if dataclasses.is_dataclass(payload) and not isinstance(payload, type):
        return {f.name: getattr(payload, f.name) for f in dataclasses.fields(payload)}
    if hasattr(payload, "__dict__") and not isinstance(payload, type):
        return {k: v for k, v in vars(payload).items() if not k.startswith("_")}
    raise JinjaRenderError(f"a Jinja payload must be a mapping or an object, not {type(payload).__name__}")


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
        if partial_engine_mismatch(provider, ref, TEMPLATE_ENGINE_JINJA):
            raise JinjaRenderError(partial_engine_message(ref, TEMPLATE_ENGINE_JINJA))
        _check_template_graph(body, provider, [*path, ref])


def render_jinja(body: str, ref: str | None, payload: Any, provider: Provider, format_: str) -> str:
    """Render Jinja ``body`` (whose own ref, when it has one, is ``ref``) against ``payload``."""
    jinja2 = jinja2_module()
    from markupsafe import Markup

    try:
        _check_template_graph(body, provider, [ref] if ref is not None else [])
    except jinja2.TemplateSyntaxError as e:
        raise JinjaRenderError(f"template syntax error: {e.message}") from e

    def forceescape(value: Any) -> Markup:
        if value is None or isinstance(value, jinja2.Undefined):
            return Markup("")
        return Markup(escapers.escape(format_, _stringify(value)))

    def escape(value: Any) -> Any:
        return value if isinstance(value, (Markup, _Rendered)) else forceescape(value)

    def finalize(value: Any) -> str:
        return str(escape(value))

    def load(name: str) -> tuple[str, None, Any] | None:
        src = provider.resolve(ref_of_template_name(name))
        return None if src is None else (src, None, lambda: False)

    env = jinja2.Environment(
        loader=jinja2.FunctionLoader(load),
        autoescape=False,
        keep_trailing_newline=True,
        finalize=finalize,
        undefined=jinja2.ChainableUndefined,
    )
    env.concat = _concat
    env.filters.update(escape=escape, e=escape, forceescape=forceescape)
    context = _context(payload)
    try:
        return str(env.from_string(body).render(**context))
    except jinja2.TemplateSyntaxError as e:
        raise JinjaRenderError(f"template syntax error: {e.message}") from e
    except (jinja2.TemplateError, TypeError, ValueError, AttributeError, KeyError) as e:
        raise JinjaRenderError(f"jinja render failed: {type(e).__name__}: {e}") from e


__all__ = ["JinjaRenderError", "render_jinja"]
