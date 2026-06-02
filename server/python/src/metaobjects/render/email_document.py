"""A rendered email value type (mirrors the TS/Java/C# ``EmailDocument``)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class EmailDocument:
    """A rendered email: subject + HTML body + optional plain-text alternative (MIME multipart/alternative)."""

    subject: str
    html_body: str
    text_body: str | None = None
