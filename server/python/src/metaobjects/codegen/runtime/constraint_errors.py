"""Map a database constraint violation to a wire response.

A generated CRUD route had no ``try``/``except`` around its write, so a driver failure
propagated out of the handler and FastAPI answered a bare 500. Two problems, and the
first is what a client actually sees:

1. **Wrong status.** A client-supplied foreign key that does not exist, or a value that
   duplicates an existing unique one, is a CLIENT error. The ``identity.reference`` and
   ``identity.secondary`` that declare those constraints are the same metadata the route
   already uses to reject bad enum members and missing required fields — it just never
   translated the constraints the DATABASE enforces.
2. A 500 tells the caller nothing actionable, and an unhandled exception's traceback can
   reach a log (or a debug response) carrying the SQL and its bound parameters. On a POST
   whose columns hold PII that is user data escaping out of generated code the adopter
   never wrote.

This is the Python port of ``runtime-ts``'s ``constraint-errors.ts``, C#'s
``ConstraintErrors`` and Java's ``ConstraintErrors``, and it deliberately keeps their
algorithm rather than inventing a fourth: walk the exception chain, collect codes and
messages, match driver error CODES first with the constraint-name vocabulary as the
fallback. ``docs/features/api-contract.md`` states the ``error`` code vocabulary is not a
hard cross-port invariant beyond ``not_found`` and the filter-parser codes, so there is
exactly ONE code here — ``constraint_violation``, with the offending KIND.

**Why the chain and not the top level:** a persistence layer wraps the driver error
(SQLAlchemy's ``IntegrityError`` carries the DBAPI exception in ``.orig``; a bare ``raise
... from e`` puts it on ``__cause__``), and the wrapper's own text may name no constraint.
A top-level-only read therefore classifies NOTHING — the same defect the TypeScript
version hit under Drizzle's wrapper and the Java one under Spring's ``DataAccessException``.

**Why no driver dependency:** this module must not import psycopg, asyncpg, sqlite3 or
SQLAlchemy — a consumer may be on any of them. SQLSTATE is read from whichever of the
conventional attributes the driver populates (``sqlstate``, ``pgcode``, ``pgerror``,
``code``), and message text covers the drivers that expose none. Only codes and messages
are read — never a statement or its parameters — so the matched text cannot carry user
data into a classification decision.
"""

from __future__ import annotations

from typing import Any, NamedTuple

__all__ = ["ConstraintFailure", "classify_constraint_error"]

#: Constraint kinds worth telling a client apart, in the cross-port snake_case spelling.
_FOREIGN_KEY = "foreign_key"
_UNIQUE = "unique"
_CHECK = "check"
_NOT_NULL = "not_null"

#: The conventional SQLSTATE/code attributes across DBAPI drivers. Read by name so this
#: module imports none of them.
_CODE_ATTRS = ("sqlstate", "pgcode", "pgerror", "code", "errno")

#: How deep to walk a chain. A wrapper whose cause is itself is legal and would otherwise
#: spin; the bound also stops a pathological chain from being walked forever.
_MAX_DEPTH = 8


class ConstraintFailure(NamedTuple):
    """A recognised constraint violation, as status plus the two body fields.

    Never carries SQL, parameters or driver text.
    """

    status: int
    constraint: str

    @property
    def error(self) -> str:
        """The single ``error`` code — see the module docstring for why there is only one."""
        return "constraint_violation"

    def body(self) -> dict[str, str]:
        """The response body for this failure."""
        return {"error": self.error, "constraint": self.constraint}


def _chain_text(exc: BaseException | None) -> str:
    """Codes and messages for ``exc`` and everything in its chain, upper-cased.

    Walks ``__cause__`` (``raise ... from``), ``__context__`` (an exception raised while
    handling another) and ``.orig`` (SQLAlchemy's wrapper attribute), which between them
    cover how every common persistence layer hands the driver error on.
    """
    parts: list[str] = []
    seen: set[int] = set()
    queue: list[Any] = [exc]
    depth = 0

    while queue and depth < _MAX_DEPTH:
        cur = queue.pop(0)
        depth += 1
        if cur is None or id(cur) in seen:
            continue
        seen.add(id(cur))

        for attr in _CODE_ATTRS:
            value = getattr(cur, attr, None)
            if value is not None and not callable(value):
                parts.append(str(value))
        try:
            parts.append(str(cur))
        except Exception:  # noqa: BLE001 - a driver's __str__ must never break classification
            pass

        for attr in ("__cause__", "__context__", "orig"):
            nxt = getattr(cur, attr, None)
            if nxt is not None and id(nxt) not in seen:
                queue.append(nxt)

    return " ".join(parts).upper()


def _kind_of(haystack: str) -> str | None:
    """Ordered most- to least-specific, matching the other ports arm for arm.

    A foreign-key violation's message can also contain the word "KEY" from a unique index
    name, so the SQLSTATE arm is what actually discriminates on Postgres; the text arms
    serve the drivers that carry no code.
    """
    if "23503" in haystack or "FOREIGN KEY" in haystack or "SQLITE_CONSTRAINT_FOREIGNKEY" in haystack:
        return _FOREIGN_KEY
    if "23505" in haystack or "UNIQUE CONSTRAINT" in haystack or "SQLITE_CONSTRAINT_UNIQUE" in haystack:
        return _UNIQUE
    if "23514" in haystack or "CHECK CONSTRAINT" in haystack or "SQLITE_CONSTRAINT_CHECK" in haystack:
        return _CHECK
    if "23502" in haystack or "NOT NULL" in haystack or "SQLITE_CONSTRAINT_NOTNULL" in haystack:
        return _NOT_NULL
    return None


def classify_constraint_error(exc: BaseException | None) -> ConstraintFailure | None:
    """The failure ``exc`` represents, or ``None`` when it is not a constraint violation.

    ``None`` means the caller must RE-RAISE, so the operator keeps the full diagnostic and
    the client gets a plain 500 carrying none of it. Classifying an unknown failure as a
    constraint violation would tell the caller a falsehood.
    """
    haystack = _chain_text(exc)
    if not haystack:
        return None

    kind = _kind_of(haystack)
    if kind is None:
        return None

    # 409 for referential/uniqueness conflicts with EXISTING state; 400 for a value the
    # request itself got wrong. Both are client errors — neither is a 500.
    status = 409 if kind in (_FOREIGN_KEY, _UNIQUE) else 400
    return ConstraintFailure(status=status, constraint=kind)
