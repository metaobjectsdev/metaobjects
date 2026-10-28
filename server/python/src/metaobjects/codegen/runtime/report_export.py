"""Report export: the request side of ``GET <report-route>?format=csv|json|xml``.

One helper, imported by a generated report router when a ``report-export`` generator is wired
for the project (``docs/features/api-contract.md``, "Report export"). It owns what is the same
for every report and for a future entity export: which ``format`` values the route wires, the
three refusal envelopes and the ``Content-Disposition`` header. It builds no response and
imports no framework, so a router of any shape can call it. The writers (CSV, XML) are NOT
here: they are generated beside the report (``<report>_export.py`` over the project's one
``report_export_writer.py``) because they depend on the report's own columns.

* **The selector is the query parameter and nothing else.** An ``Accept`` header is never
  consulted, anywhere in this module.
* **Matching is case-sensitive.** ``CSV`` and an empty ``format=`` are unknown formats.
* **No new dependency**: the standard library only.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: The formats a report route wires, in the order ``invalid_format`` lists them. ``xlsx`` is
#: reserved for a later generator and is refused today like any unknown value.
EXPORT_FORMATS: tuple[str, ...] = ("csv", "json", "xml")

#: The ``Content-Type`` of each wired format. ``json`` is the list route's own.
EXPORT_CONTENT_TYPES: Mapping[str, str] = {
    "csv": "text/csv; charset=utf-8",
    "json": "application/json",
    "xml": "application/xml",
}

#: ``withCount`` values that ask for the ``{rows, total}`` envelope.
_TRUTHY_FLAGS = frozenset({"1", "true"})


def requested_format(query_params: Mapping[str, str]) -> str | None:
    """The raw ``format`` query value, or ``None`` when the parameter is absent.

    An empty ``format=`` is returned as ``""`` (present, and not a wired format)."""
    return query_params.get("format")


def is_truthy_flag(value: str | None) -> bool:
    """Whether a ``withCount`` query value is truthy: ``1`` or ``true`` (any case)."""
    return value is not None and value.lower() in _TRUTHY_FLAGS


def invalid_format_envelope(formats: tuple[str, ...] = EXPORT_FORMATS) -> dict[str, Any]:
    """``400 {"error": "invalid_format", "expected": [the wired formats]}``."""
    return {"error": "invalid_format", "expected": list(formats)}


def export_with_count_envelope() -> dict[str, Any]:
    """``400 {"error": "export_with_count"}``: a CSV or XML export has no ``{rows, total}``
    envelope; only JSON carries it. ``message`` is free prose."""
    return {
        "error": "export_with_count",
        "message": "withCount cannot be combined with format=csv or format=xml: only JSON carries the { rows, total } envelope.",
    }


def export_too_large_envelope(max_rows: int) -> dict[str, Any]:
    """``400 {"error": "export_too_large", "maxRows": N}``, answered before any body byte."""
    return {"error": "export_too_large", "maxRows": max_rows}


def content_disposition(segment: str, fmt: str) -> str:
    """``attachment; filename="<segment>.<ext>"``: the header every successful export carries."""
    return f'attachment; filename="{segment}.{fmt}"'
