"""``constraint_errors`` — the Python half of the cross-port constraint mapping.

Ported from ``runtime-ts``'s ``constraint-errors.ts``, C#'s ``ConstraintErrors`` and Java's
``ConstraintErrors``, so these cases mirror theirs arm for arm rather than testing a fourth
design.
"""

from __future__ import annotations

from metaobjects.codegen.runtime.constraint_errors import classify_constraint_error


class _DriverError(Exception):
    """A DBAPI-shaped error: message plus the SQLSTATE attribute drivers populate."""

    def __init__(self, message: str, sqlstate: str | None = None) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate


def test_foreign_key_violation_is_409() -> None:
    failure = classify_constraint_error(
        _DriverError('insert on table "leg" violates foreign key constraint', "23503")
    )
    assert failure is not None
    assert failure.constraint == "foreign_key"
    # A dangling reference conflicts with EXISTING state.
    assert failure.status == 409
    assert failure.error == "constraint_violation"
    assert failure.body() == {"error": "constraint_violation", "constraint": "foreign_key"}


def test_unique_violation_is_409() -> None:
    failure = classify_constraint_error(
        _DriverError("duplicate key value violates unique constraint", "23505")
    )
    assert failure is not None
    assert failure.constraint == "unique"
    assert failure.status == 409


def test_check_and_not_null_are_400() -> None:
    """A value the request itself got wrong, not a conflict with existing state."""
    check = classify_constraint_error(_DriverError("violates check constraint", "23514"))
    assert check is not None and check.constraint == "check" and check.status == 400

    not_null = classify_constraint_error(
        _DriverError("null value in column violates not-null constraint", "23502")
    )
    assert not_null is not None and not_null.constraint == "not_null" and not_null.status == 400


def test_reads_through_a_wrapper_rather_than_the_top_level() -> None:
    """The defect the chain walk exists for.

    A persistence layer's wrapper names no constraint in its own text, so a top-level-only
    read classifies NOTHING and every violation falls to a bare 500 — exactly how the
    TypeScript version first behaved under Drizzle's wrapper.
    """
    driver = _DriverError("violates foreign key constraint", "23503")
    try:
        raise driver
    except _DriverError as exc:
        wrapper = RuntimeError("statement failed")
        wrapper.__cause__ = exc

    assert classify_constraint_error(RuntimeError("statement failed")) is None
    assert classify_constraint_error(wrapper) is not None


def test_reads_the_sqlalchemy_orig_attribute() -> None:
    """SQLAlchemy hands the DBAPI exception on ``.orig`` rather than ``__cause__``."""

    class IntegrityError(Exception):
        def __init__(self, orig: Exception) -> None:
            super().__init__("(psycopg.errors.UniqueViolation) …")
            self.orig = orig

    failure = classify_constraint_error(
        IntegrityError(_DriverError("duplicate key value", "23505"))
    )
    assert failure is not None
    assert failure.constraint == "unique"


def test_falls_back_to_message_text_when_the_driver_gives_no_code() -> None:
    failure = classify_constraint_error(
        _DriverError("UNIQUE constraint failed: shipment.reference")
    )
    assert failure is not None
    assert failure.constraint == "unique"


def test_returns_none_for_anything_that_is_not_a_constraint_violation() -> None:
    """``None`` means RE-RAISE: the operator keeps the diagnostic, the client gets none of it."""
    assert classify_constraint_error(RuntimeError("connection refused")) is None
    assert classify_constraint_error(ValueError("pool exhausted")) is None
    assert classify_constraint_error(None) is None


def test_tolerates_a_self_referential_chain() -> None:
    """A cause cycle is legal and must not spin."""
    a = RuntimeError("a")
    b = RuntimeError("b")
    a.__cause__ = b
    b.__cause__ = a
    assert classify_constraint_error(a) is None
