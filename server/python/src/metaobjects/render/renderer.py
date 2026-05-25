"""Mustache-driven render pipeline for ``template.*`` (FR-004).

Pipeline: resolve template text (inline or via provider) → pre-expand partials
by recursive inlining (cycle-guarded, MAX_DEPTH=32) → execute a small
purpose-built Mustache interpreter that applies the format-keyed
:mod:`escapers` per variable substitution → truncate to ``maxChars`` if set.

Pre-expanding partials before interpretation guarantees deterministic
cross-port whitespace and lets the engine own cycle detection. The Mustache
subset implemented (interpolation, raw triple-stache, sections, inverted
sections, partials, comments) is the corpus's vocabulary — set-delimiter
directives are intentionally NOT supported (matches the verify side and the
TS/C#/Java engines).

Mirrors ``server/java/render/.../Renderer.java`` and
``server/csharp/MetaObjects.Render/Renderer.cs``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from . import escapers
from .verify import InMemoryProvider, Provider

MAX_DEPTH = 32

# {{> name }} — captures the reference between the marker and the closing }}.
_PARTIAL_PATTERN = re.compile(r"\{\{>\s*([^\s}]+)\s*\}\}")


class RenderError(Exception):
    """Anything that goes wrong during render (unresolved partial, cycle, etc.)."""


@dataclass
class RenderRequest:
    """One render call.

    Exactly one of ``template`` / ``ref`` must be set. ``payload`` is the data
    object the Mustache interpreter walks. ``provider`` resolves
    ``{{> partial}}`` references and (when ``ref`` is set) the top-level
    template body. ``format`` defaults to ``"text"`` (no escaping). ``max_chars``
    optionally truncates the final output.
    """

    payload: Any
    provider: Provider
    template: str | None = None
    ref: str | None = None
    format: str = escapers.FORMAT_TEXT
    max_chars: int | None = None


def render(req: RenderRequest) -> str:
    _validate(req)
    body = req.template if req.template is not None else _resolve_or_raise(req.provider, req.ref)
    expanded = _pre_expand_partials(body, req.provider, [])
    out = _interpret(expanded, req.payload, req.format)
    if req.max_chars is not None and len(out) > req.max_chars:
        out = out[: req.max_chars]
    return out


# ---------------------------------------------------------------------------
# Validation + partial pre-expansion
# ---------------------------------------------------------------------------


def _validate(req: RenderRequest) -> None:
    if req.provider is None:
        raise RenderError("RenderRequest.provider is required")
    if req.payload is None:
        raise RenderError("RenderRequest.payload is required")
    if req.template is None and req.ref is None:
        raise RenderError("RenderRequest must set either template or ref")
    if req.template is not None and req.ref is not None:
        raise RenderError("RenderRequest must set template OR ref, not both")


def _resolve_or_raise(provider: Provider, ref: str) -> str:
    text = provider.resolve(ref)
    if text is None:
        raise RenderError(f"unresolved ref: {ref}")
    return text


def _pre_expand_partials(text: str, provider: Provider, stack: list[str]) -> str:
    if len(stack) >= MAX_DEPTH:
        raise RenderError(
            f"partial depth exceeded {MAX_DEPTH} (chain: {' -> '.join(stack)})"
        )

    def replace(match: re.Match[str]) -> str:
        ref = match.group(1)
        if ref in stack:
            raise RenderError(f"partial cycle: {' -> '.join(stack)} -> {ref}")
        body = provider.resolve(ref)
        if body is None:
            raise RenderError(f"unresolved partial: {ref}")
        stack.append(ref)
        try:
            return _pre_expand_partials(body, provider, stack)
        finally:
            stack.pop()

    return _PARTIAL_PATTERN.sub(replace, text)


# ---------------------------------------------------------------------------
# Mustache interpreter — purpose-built, minimal vocabulary
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Text:
    value: str


@dataclass(frozen=True)
class _Interp:
    path: str
    raw: bool  # True for {{{x}}} or {{&x}}


@dataclass(frozen=True)
class _Section:
    path: str
    inverted: bool
    children: tuple["_Node", ...] = field(default=())


_Node = _Text | _Interp | _Section


def _tokenize(text: str) -> tuple[_Node, ...]:
    tokens, _ = _parse(text, 0)
    return tokens


# Sigils whose tags are "block-level" (eligible for the standalone-line whitespace
# strip rule per the Mustache spec). Interpolation tags are NOT block-level —
# `{{x}}` alone on a line keeps its surrounding newline.
_BLOCK_SIGILS = frozenset(("#", "^", "/", "!", ">"))


def _is_standalone_line(text: str, open_idx: int, after_idx: int) -> tuple[bool, int]:
    """Return ``(is_standalone, eat_to)`` for a tag opening at *open_idx* and
    closing at *after_idx*.

    A tag is "standalone" iff the text from the previous newline (or BOF) to
    *open_idx* is whitespace AND the text from *after_idx* to the next newline
    (or EOF) is whitespace. When standalone, *eat_to* is one past the trailing
    newline — so callers can advance past it — and the prior Text token's
    leading-line whitespace should be trimmed.
    """
    # Look back to start of line.
    line_start = text.rfind("\n", 0, open_idx) + 1  # rfind == -1 → 0
    before = text[line_start:open_idx]
    if before and not before.isspace():
        return False, after_idx
    # Look forward to end of line.
    eat_to = after_idx
    while eat_to < len(text) and text[eat_to] != "\n":
        if not text[eat_to].isspace():
            return False, after_idx
        eat_to += 1
    if eat_to < len(text):
        eat_to += 1  # include the newline itself
    return True, eat_to


def _strip_trailing_line_ws(t: _Text) -> _Text:
    """Drop the trailing-line whitespace (post the last newline) from *t* — the
    "leading-line ws" half of the standalone-tag whitespace rule."""
    v = t.value
    nl = v.rfind("\n")
    if nl < 0:
        # Whole text is whitespace — if so, drop it; otherwise keep as-is.
        return _Text("") if v.isspace() else t
    return _Text(v[: nl + 1])


def _parse(text: str, pos: int) -> tuple[tuple[_Node, ...], int]:
    out: list[_Node] = []
    while pos < len(text):
        open_idx = text.find("{{", pos)
        if open_idx < 0:
            if pos < len(text):
                out.append(_Text(text[pos:]))
            return tuple(out), len(text)
        # Defer creating the preceding Text token until we know whether
        # this tag is standalone (in which case we trim its trailing-line ws).
        leading_text = text[pos:open_idx]
        triple = open_idx + 2 < len(text) and text[open_idx + 2] == "{"
        close_delim = "}}}" if triple else "}}"
        content_start = open_idx + (3 if triple else 2)
        close_idx = text.find(close_delim, content_start)
        if close_idx < 0:
            # Malformed — treat the rest as plain text.
            out.append(_Text(text[pos:]))
            return tuple(out), len(text)
        content = text[content_start:close_idx].strip()
        after_idx = close_idx + len(close_delim)

        sigil = content[0] if (not triple and content) else ""
        is_block = sigil in _BLOCK_SIGILS
        if is_block:
            standalone, eat_to = _is_standalone_line(text, open_idx, after_idx)
            if standalone:
                # Trim the leading-line ws off the preceding text segment.
                leading_text_trimmed = _strip_trailing_line_ws(_Text(leading_text)).value
                if leading_text_trimmed:
                    out.append(_Text(leading_text_trimmed))
                pos = eat_to
            else:
                if leading_text:
                    out.append(_Text(leading_text))
                pos = after_idx
        else:
            if leading_text:
                out.append(_Text(leading_text))
            pos = after_idx

        if triple:
            out.append(_Interp(content, raw=True))
            continue
        if not content:
            continue

        name = content[1:].strip() if len(content) > 1 else ""

        if sigil == "!":
            continue  # comment
        if sigil in ("#", "^"):
            children, pos = _parse(text, pos)
            out.append(_Section(name, inverted=(sigil == "^"), children=children))
        elif sigil == "/":
            return tuple(out), pos  # close — caller resumes
        elif sigil == "&":
            out.append(_Interp(name, raw=True))
        elif sigil == ">":
            # Partial — should have been pre-expanded. If we still see one, it
            # means a partial body referenced an unknown one. Render as empty
            # so the rendered output stays well-formed; the pre-expand step is
            # responsible for raising on unresolved partials.
            continue
        else:
            out.append(_Interp(content, raw=False))
    return tuple(out), pos


def _interpret(text: str, payload: Any, format_: str) -> str:
    tokens = _tokenize(text)
    parts: list[str] = []
    _emit(tokens, [payload], parts, format_)
    return "".join(parts)


def _emit(
    tokens: tuple[_Node, ...],
    stack: list[Any],
    out: list[str],
    format_: str,
) -> None:
    for tok in tokens:
        if isinstance(tok, _Text):
            out.append(tok.value)
        elif isinstance(tok, _Interp):
            value = _resolve(tok.path, stack)
            if value is None or value is False:
                continue
            text = _stringify(value)
            out.append(text if tok.raw else escapers.escape(format_, text))
        elif isinstance(tok, _Section):
            value = _resolve(tok.path, stack)
            truthy = _truthy(value)
            if tok.inverted:
                if not truthy:
                    _emit(tok.children, stack, out, format_)
                continue
            if not truthy:
                continue
            if isinstance(value, list):
                for item in value:
                    stack.append(item)
                    try:
                        _emit(tok.children, stack, out, format_)
                    finally:
                        stack.pop()
            elif isinstance(value, dict):
                stack.append(value)
                try:
                    _emit(tok.children, stack, out, format_)
                finally:
                    stack.pop()
            else:
                # truthy scalar — render body once in current context
                _emit(tok.children, stack, out, format_)


def _resolve(path: str, stack: list[Any]) -> Any:
    """Mustache lookup: first segment walks the context stack innermost→outermost;
    remaining segments descend into the resolved value. Implicit iterator
    ``{{.}}`` returns the top of the stack."""
    if path == ".":
        return stack[-1] if stack else None
    segs = path.split(".")
    current = _lookup(stack, segs[0])
    for seg in segs[1:]:
        if current is None:
            return None
        current = _lookup([current], seg)
    return current


def _lookup(stack: list[Any], name: str) -> Any:
    for ctx in reversed(stack):
        if isinstance(ctx, dict) and name in ctx:
            return ctx[name]
    return None


def _truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, list) and not value:
        return False
    if isinstance(value, str) and not value:
        return False
    return True


def _stringify(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        # Avoid Python's "1.0" suffix for whole-number floats.
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)
    return str(value)


__all__ = [
    "InMemoryProvider",
    "MAX_DEPTH",
    "Provider",
    "RenderError",
    "RenderRequest",
    "render",
]
