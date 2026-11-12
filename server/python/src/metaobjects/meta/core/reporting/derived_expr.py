"""FR-044 R13 — the ``@expr`` grammar of a ``measure.derived``: FR-037 R5's first arithmetic wave.

Ported from ``server/typescript/packages/metadata/src/core/reporting/derived-expr.ts``. A closed
subset of the attr.expression node grammar: an operand is ``{ field: name }`` (a sibling
measure.aggregate or measure.ratio, or a numeric attribute dimension the report lists) or
``{ value: number }``; an operation is ``{ fn: add | subtract | multiply | divide, args: [a, b] }``.
origin.computed's grammar does not take the arithmetic members yet.
"""
from __future__ import annotations

import math

from .reporting_constants import DERIVED_FNS

_KEY_FIELD = "field"
_KEY_VALUE = "value"
_KEY_FN = "fn"
_KEY_ARGS = "args"


def _is_finite_number(v: object) -> bool:
    # bool is an int subclass in Python, and True is not a number here.
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    return isinstance(v, float) and math.isfinite(v)


def is_derived_expr(node: object) -> bool:
    """True for a node of the grammar, its whole subtree included."""
    if not isinstance(node, dict):
        return False
    keys = set(node)
    if keys == {_KEY_FIELD}:
        return isinstance(node[_KEY_FIELD], str) and len(node[_KEY_FIELD]) > 0
    if keys == {_KEY_VALUE}:
        return _is_finite_number(node[_KEY_VALUE])
    if keys == {_KEY_FN, _KEY_ARGS}:
        args = node[_KEY_ARGS]
        return (
            node[_KEY_FN] in DERIVED_FNS
            and isinstance(args, list)
            and len(args) == 2
            and all(is_derived_expr(a) for a in args)
        )
    return False


def derived_expr_fields(node: object, out: list[str] | None = None) -> list[str]:
    """The names a well-formed expression's ``{ field }`` operands read, each once, in first-read order."""
    if out is None:
        out = []
    if isinstance(node, dict):
        name = node.get(_KEY_FIELD)
        if isinstance(name, str):
            if name not in out:
                out.append(name)
        elif isinstance(node.get(_KEY_ARGS), list):
            for a in node[_KEY_ARGS]:
                derived_expr_fields(a, out)
    return out
