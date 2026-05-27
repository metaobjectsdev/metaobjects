"""Runtime helper shipped alongside the generated FastAPI routers. Parses
the cross-port FR-009 filter grammar ``filter[<field>][<op>]=<value>`` (and
the ``filter[<field>]=<value>`` sugar form for ``eq``) against a per-entity
allowlist.

This module is part of ``metaobjects.codegen``'s public runtime surface —
generated routers import + call into it directly. It is intentionally
substrate-agnostic: ``parse_filter`` returns a list of ``FilterPredicate``
records that the consumer's repository implementation translates to its
persistence DSL of choice (SQLAlchemy, asyncpg, pg8000, etc.).

Returned ``FilterParseResult`` is either:

* ``predicates`` populated + ``error_envelope`` ``None`` — success path; the
  generated router passes ``predicates`` into the repository.
* ``error_envelope`` non-``None`` (one of ``invalid_filter_field`` /
  ``invalid_filter_op`` / ``invalid_filter_value``) — the generated router
  raises ``HTTPException(status_code=400, detail=result.error_envelope)``.

Mirror of the Java ``FilterParser`` / Kotlin ``KotlinFilterAllowlistGenerator`` /
C# ``FilterParser`` ports — same wire grammar, same error envelopes, same
substrate-neutral predicate shape.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping
from urllib.parse import unquote_plus


# Sentinel returned by `_coerce_value` on a parse failure.
_INVALID_VALUE = object()

# Error envelope keys — must stay identical across all ports.
_ERR_FIELD = "invalid_filter_field"
_ERR_OP = "invalid_filter_op"
_ERR_VALUE = "invalid_filter_value"


@dataclass(frozen=True)
class FilterPredicate:
    """A single validated filter clause from the URL.

    The ``value`` field holds either:

    * a ``bool`` (only for the ``isNull`` op),
    * a ``list[str]`` (only for the ``in`` op — comma-separated values trimmed),
    * a ``str`` (for ``eq`` / ``ne`` / ``gt`` / ``gte`` / ``lt`` / ``lte`` /
      ``like`` — raw URL-decoded text, the repository binds it via
      parameterized SQL so the driver picks the column type).
    """

    field: str
    op: str
    value: Any


@dataclass(frozen=True)
class FilterParseResult:
    """Outcome of parsing the ``filter[...]`` query params.

    Exactly one of ``predicates`` (success) / ``error_envelope`` (failure)
    is populated. On error, ``predicates`` is an empty list.
    """

    predicates: list[FilterPredicate] = field(default_factory=list)
    error_envelope: dict[str, str] | None = None


def parse_filter(
    query_params: Iterable[tuple[str, str]] | Mapping[str, str],
    allowed_fields: Iterable[str],
    ops_by_field: Mapping[str, Iterable[str]],
) -> FilterParseResult:
    """Parse the ``filter[<field>][<op>]=<value>`` grammar from query params.

    ``query_params`` is the FastAPI ``Request.query_params`` object (a
    multi-dict-like that yields ``(key, value)`` pairs when iterated as
    ``.multi_items()``). For testing, a plain ``list[tuple[str, str]]`` works
    too — anything iterable that yields the raw key/value pairs in URL
    order. A plain ``Mapping`` collapses repeats (last-value-wins), which is
    fine for tests that don't repeat keys.

    Returns a ``FilterParseResult`` — on success, ``predicates`` carries the
    validated + coerced filter list (preserving URL order); on failure,
    ``error_envelope`` is one of the cross-port envelopes
    (``invalid_filter_field`` / ``invalid_filter_op`` /
    ``invalid_filter_value``).
    """
    allowed_set = set(allowed_fields)
    ops_map: dict[str, frozenset[str]] = {
        k: frozenset(v) for k, v in ops_by_field.items()
    }

    pairs = _as_pairs(query_params)

    out: list[FilterPredicate] = []
    for raw_key, raw_value in pairs:
        # FastAPI's `Request.query_params` already URL-decodes both halves.
        # If callers pass raw URL-encoded pairs (e.g. from a hand-built test),
        # this is a no-op; if they pass pre-decoded text, also a no-op.
        key = raw_key
        value = raw_value
        if not key.startswith("filter["):
            continue

        # Parse `filter[field]` or `filter[field][op]`. Bracket payload is
        # opaque per the spec (no nested brackets).
        first_close = key.find("]", 7)
        if first_close < 0:
            continue
        field_name = key[7:first_close]
        rest = first_close + 1
        if rest >= len(key):
            op = "eq"
        elif key[rest] == "[":
            second_close = key.find("]", rest + 1)
            if second_close < 0:
                continue
            op = key[rest + 1 : second_close]
        else:
            continue

        if field_name not in allowed_set:
            return FilterParseResult(error_envelope={"error": _ERR_FIELD})
        ops = ops_map.get(field_name)
        if ops is None or op not in ops:
            return FilterParseResult(error_envelope={"error": _ERR_OP})
        coerced = _coerce_value(value, op)
        if coerced is _INVALID_VALUE:
            return FilterParseResult(error_envelope={"error": _ERR_VALUE})
        out.append(FilterPredicate(field=field_name, op=op, value=coerced))

    return FilterParseResult(predicates=out)


def _coerce_value(raw: str, op: str) -> Any:
    """Normalize a raw URL-decoded string into a typed value for ``op``.

    The concrete substrate type (number vs string vs date) is left for the
    repository to handle — this parser only normalizes the structural shape:
    a ``list[str]`` for ``in``, a ``bool`` for ``isNull``, and a raw ``str``
    for the scalar comparison ops.
    """
    if op == "isNull":
        if raw == "true":
            return True
        if raw == "false":
            return False
        return _INVALID_VALUE
    if op == "in":
        return [p.strip() for p in raw.split(",")]
    # For eq/ne/gt/gte/lt/lte/like the parser passes through the raw string
    # value; the repository binds it via parameterized SQL (where the driver
    # handles the coercion to the column type).
    return raw


def _as_pairs(
    query_params: Iterable[tuple[str, str]] | Mapping[str, str],
) -> list[tuple[str, str]]:
    """Normalize a Mapping / FastAPI MultiDict / list-of-pairs to pairs."""
    # FastAPI's `QueryParams` exposes `multi_items()` returning a list of
    # `(key, value)` tuples preserving URL order + repeats.
    multi_items = getattr(query_params, "multi_items", None)
    if callable(multi_items):
        return [(str(k), str(v)) for k, v in multi_items()]
    if isinstance(query_params, Mapping):
        return [(str(k), str(v)) for k, v in query_params.items()]
    # Already an iterable of pairs.
    return [(str(k), str(v)) for k, v in query_params]


def parse_filter_qs(
    raw_query: str | None,
    allowed_fields: Iterable[str],
    ops_by_field: Mapping[str, Iterable[str]],
) -> FilterParseResult:
    """Convenience wrapper that takes a raw URL query string (without leading
    ``?``) and parses it via ``parse_filter``. Useful for tests + non-FastAPI
    consumers."""
    if not raw_query:
        return FilterParseResult(predicates=[])
    pairs: list[tuple[str, str]] = []
    for pair in raw_query.split("&"):
        if not pair:
            continue
        eq = pair.find("=")
        if eq < 0:
            pairs.append((unquote_plus(pair), ""))
        else:
            pairs.append((unquote_plus(pair[:eq]), unquote_plus(pair[eq + 1 :])))
    return parse_filter(pairs, allowed_fields, ops_by_field)
