"""Assertion engine for api-contract-conformance scenarios.

The vocabulary (``equals`` / ``length`` / ``ids`` / ``names`` / ``row`` /
``hasId`` / ``envelope`` / ``error`` / ``empty``) is the cross-port contract —
every per-port runner must implement these keys identically. See
``fixtures/api-contract-conformance/README.md``.

``body`` here is the parsed JSON response (dict / list / scalar / None).
Mirrors ``ApiContractAssertions.java`` and ``ApiContractAssertions.kt``.
"""
from __future__ import annotations

from typing import Any


def assert_response(
    scenario_name: str,
    request_id: str,
    expect_status: int,
    expect_body: dict[str, Any] | None,
    status: int,
    body: Any,
) -> None:
    """Walk the expect-body vocabulary against an actual response."""
    if status != expect_status:
        raise AssertionError(
            f"{scenario_name} / {request_id}: expected status {expect_status}, "
            f"got {status}; body: {body!r}"
        )
    if expect_body is None:
        return

    if expect_body.get("empty") is True:
        if not _is_empty(body):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected empty body, got: {body!r}"
            )
        return

    if "equals" in expect_body:
        want = expect_body["equals"]
        if not _structural_equals(body, want):
            raise AssertionError(
                f"{scenario_name} / {request_id}: body mismatch\n"
                f"  expected: {want!r}\n"
                f"  actual:   {body!r}"
            )
        return

    if expect_body.get("envelope") is True:
        if not isinstance(body, dict):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected envelope {{rows,total}}, got: {body!r}"
            )
        rows = body.get("rows")
        if not isinstance(rows, list):
            raise AssertionError(
                f"{scenario_name} / {request_id}: envelope.rows missing or not a list; got: {body!r}"
            )
        total = body.get("total")
        if not isinstance(total, (int, float)) or isinstance(total, bool):
            raise AssertionError(
                f"{scenario_name} / {request_id}: envelope.total missing or not a number; got: {body!r}"
            )
        want_len = expect_body.get("rowsLength")
        if isinstance(want_len, int) and len(rows) != want_len:
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected rows.length={want_len}, got {len(rows)}"
            )
        want_total = expect_body.get("total")
        if isinstance(want_total, int) and int(total) != want_total:
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected total={want_total}, got {int(total)}"
            )
        return

    if "error" in expect_body:
        want_err = expect_body["error"]
        actual_err = body.get("error") if isinstance(body, dict) else None
        if actual_err != want_err:
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected error=\"{want_err}\", got: {body!r}"
            )
        return

    if "length" in expect_body:
        want_len = expect_body["length"]
        if not isinstance(body, list):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected array, got: {body!r}"
            )
        if len(body) != want_len:
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected length={want_len}, got {len(body)}"
            )

    if "ids" in expect_body:
        want_ids = expect_body["ids"]
        if not isinstance(body, list):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected array, got: {body!r}"
            )
        actual_ids = [row.get("id") if isinstance(row, dict) else None for row in body]
        if actual_ids != want_ids:
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected ids {want_ids}, got {actual_ids}"
            )

    if "names" in expect_body:
        want_names = expect_body["names"]
        if not isinstance(body, list):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected array, got: {body!r}"
            )
        actual_names = [row.get("name") if isinstance(row, dict) else None for row in body]
        if actual_names != want_names:
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected names {want_names}, got {actual_names}"
            )

    if "namesUnordered" in expect_body:
        # FR-018 M:N: related-row order through a junction is not contractual;
        # compare the multiset of `name` fields (order-insensitive).
        want_names = expect_body["namesUnordered"]
        if not isinstance(body, list):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected array, got: {body!r}"
            )
        actual_names = [row.get("name") if isinstance(row, dict) else None for row in body]
        if sorted(actual_names, key=lambda v: (v is None, v)) != sorted(
            want_names, key=lambda v: (v is None, v)
        ):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected names (unordered) "
                f"{want_names}, got {actual_names}"
            )

    if "row" in expect_body:
        want_row = expect_body["row"]
        if not isinstance(body, dict):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected object, got: {body!r}"
            )
        for k, v in want_row.items():
            actual = body.get(k)
            if not _structural_equals(actual, v):
                raise AssertionError(
                    f"{scenario_name} / {request_id}: expected row.{k}={v!r}, got {actual!r}"
                )

    if expect_body.get("hasId") is True:
        if not isinstance(body, dict):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected object, got: {body!r}"
            )
        ident = body.get("id")
        if not isinstance(ident, (int, float)) or isinstance(ident, bool):
            raise AssertionError(
                f"{scenario_name} / {request_id}: expected numeric id in body, got: {body!r}"
            )


def _structural_equals(a: Any, b: Any) -> bool:
    """Recursively compare; ints and floats with equal long value match."""
    if a is b:
        return True
    if a is None or b is None:
        return a is None and b is None
    # Numbers: compare as int when both are numeric (mirror Java's longValue compare).
    if isinstance(a, (int, float)) and not isinstance(a, bool) \
            and isinstance(b, (int, float)) and not isinstance(b, bool):
        return int(a) == int(b)
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        return all(_structural_equals(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a.keys()) != set(b.keys()):
            return False
        return all(_structural_equals(a[k], b[k]) for k in a)
    return a == b


def _is_empty(body: Any) -> bool:
    if body is None:
        return True
    if isinstance(body, (str, list, dict)):
        return len(body) == 0
    return False
