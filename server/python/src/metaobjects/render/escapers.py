"""Format-keyed escapers for the render engine (FR-004).

Tier-1 invariant: per-format escaping behavior is character-by-character
identical to TS (``packages/render/src/escapers.ts``), C#
(``MetaObjects.Render/Escapers.cs``), and Java
(``server/java/render/.../Escapers.java``).

``{{var}}`` substitutions in a Mustache template are escaped per the
configured format; ``{{{var}}}`` bypasses escaping (Mustache's
"triple-stache" raw form is preserved by the renderer).
"""
from __future__ import annotations

FORMAT_TEXT = "text"
FORMAT_HTML = "html"
FORMAT_XML = "xml"
FORMAT_CSV = "csv"
FORMAT_JSON = "json"
FORMAT_MARKDOWN = "markdown"
FORMAT_SPREADSHEET = "spreadsheet"


def _escape_xml(s: str) -> str:
    out: list[str] = []
    for c in s:
        if c == "&":
            out.append("&amp;")
        elif c == "<":
            out.append("&lt;")
        elif c == ">":
            out.append("&gt;")
        elif c == '"':
            out.append("&quot;")
        elif c == "'":
            out.append("&#39;")
        else:
            out.append(c)
    return "".join(out)


def _injection_guard(s: str) -> str:
    """OWASP CSV/Excel formula-injection guard: prefix a literal apostrophe when
    the cell starts with an active char (``=``, ``+``, ``-``, ``@``, tab, CR)."""
    if not s:
        return s
    first = s[0]
    if first in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


def _escape_csv(s: str) -> str:
    guarded = _injection_guard(s)
    needs_quote = any(ch in guarded for ch in (",", '"', "\n", "\r"))
    if not needs_quote:
        return guarded
    return '"' + guarded.replace('"', '""') + '"'


def _escape_json(s: str) -> str:
    """Mirrors JS ``JSON.stringify(s).slice(1, -1)``: escape ``"``, ``\\``, and
    ASCII control chars; nothing else (no HTML-safety escaping of ``< > &``)."""
    out: list[str] = []
    for c in s:
        if c == '"':
            out.append('\\"')
        elif c == "\\":
            out.append("\\\\")
        elif c == "\b":
            out.append("\\b")
        elif c == "\f":
            out.append("\\f")
        elif c == "\n":
            out.append("\\n")
        elif c == "\r":
            out.append("\\r")
        elif c == "\t":
            out.append("\\t")
        elif ord(c) < 0x20:
            out.append(f"\\u{ord(c):04x}")
        else:
            out.append(c)
    return "".join(out)


def _escape_spreadsheet(s: str) -> str:
    """XML-escape the content first, then guard — the guard's leading quote
    stays a literal apostrophe (which tells Excel "treat as text"), not
    ``&#39;``."""
    return _injection_guard(_escape_xml(s))


_REGISTRY = {
    FORMAT_TEXT: lambda s: s,
    FORMAT_MARKDOWN: lambda s: s,
    FORMAT_HTML: _escape_xml,  # HTML uses XML entity set per FR-004 spec
    FORMAT_XML: _escape_xml,
    FORMAT_CSV: _escape_csv,
    FORMAT_SPREADSHEET: _escape_spreadsheet,
    FORMAT_JSON: _escape_json,
}


def escape(format_: str, value: str) -> str:
    """Escape *value* per *format_*. Unknown formats raise ``ValueError``."""
    fn = _REGISTRY.get(format_)
    if fn is None:
        raise ValueError(f'unknown render format "{format_}"')
    return fn(value)
