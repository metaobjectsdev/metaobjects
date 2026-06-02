"""Unit tests for the ``EmailDocument`` value type (mirrors C# EmailDocumentTests)."""

from __future__ import annotations

import pytest

from metaobjects.render import EmailDocument


def test_constructs_with_default_none_text_body() -> None:
    email = EmailDocument("s", "h")
    assert email.subject == "s"
    assert email.html_body == "h"
    assert email.text_body is None


def test_constructs_with_text_body() -> None:
    email = EmailDocument("s", "h", "t")
    assert email.subject == "s"
    assert email.html_body == "h"
    assert email.text_body == "t"


def test_is_frozen() -> None:
    email = EmailDocument("s", "h")
    with pytest.raises((AttributeError, TypeError)):
        email.subject = "other"  # type: ignore[misc]
