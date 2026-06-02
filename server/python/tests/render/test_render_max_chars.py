"""Unit tests for the ``@maxChars`` render budget.

Canonical cross-port behavior: ``max_chars`` is a fail-closed budget. Output
within (or exactly at) the budget renders normally; output that exceeds the
budget RAISES ``RenderError`` (never silently truncates). The error message
shape matches TS/C#/Java: ``render exceeded maxChars budget: <len> > <cap>``.
"""

from __future__ import annotations

import pytest

from metaobjects.render.renderer import (
    InMemoryProvider,
    RenderError,
    RenderRequest,
    render,
)


def _req(template: str, payload: dict, max_chars: int | None) -> RenderRequest:
    return RenderRequest(
        payload=payload,
        provider=InMemoryProvider({}),
        template=template,
        format="text",
        max_chars=max_chars,
    )


def test_within_budget_returns_normally() -> None:
    # "Hi Ada." is 7 chars; a budget of 100 is comfortably within budget.
    assert render(_req("Hi {{name}}.", {"name": "Ada"}, 100)) == "Hi Ada."


def test_exactly_at_budget_is_allowed() -> None:
    # "Hi Ada." is exactly 7 chars; a budget of 7 is at the budget → allowed.
    assert render(_req("Hi {{name}}.", {"name": "Ada"}, 7)) == "Hi Ada."


def test_over_budget_raises() -> None:
    # "Hi Ada." is 7 chars; a budget of 6 is over budget → RAISE (fail-closed).
    with pytest.raises(RenderError, match="maxChars"):
        render(_req("Hi {{name}}.", {"name": "Ada"}, 6))


def test_error_reports_budget_and_actual_length() -> None:
    # 10-char output, budget of 5 — message shape matches TS/C#/Java.
    with pytest.raises(RenderError) as exc:
        render(_req("{{x}}", {"x": "abcdefghij"}, 5))
    assert str(exc.value) == "render exceeded maxChars budget: 10 > 5"


def test_null_max_chars_means_no_guard() -> None:
    # No budget set → long output renders without raising.
    assert render(_req("{{x}}", {"x": "abcdefghij"}, None)) == "abcdefghij"
