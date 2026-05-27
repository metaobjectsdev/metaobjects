"""Canonical, dialect-neutral SQL type. Port of TS sql-type.ts."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Union


@dataclass(frozen=True)
class Text:
    """maxLength None → TEXT, otherwise VARCHAR(maxLength)."""
    max_length: int | None = None
    kind: Literal["text"] = field(default="text", init=False)


@dataclass(frozen=True)
class Integer:
    """bits is 32 (INTEGER) or 64 (BIGINT)."""
    bits: int = 64
    kind: Literal["integer"] = field(default="integer", init=False)


@dataclass(frozen=True)
class Real:
    kind: Literal["real"] = field(default="real", init=False)


@dataclass(frozen=True)
class Numeric:
    precision: int | None = None
    scale: int | None = None
    kind: Literal["numeric"] = field(default="numeric", init=False)


@dataclass(frozen=True)
class Boolean:
    kind: Literal["boolean"] = field(default="boolean", init=False)


@dataclass(frozen=True)
class Timestamp:
    with_timezone: bool = False
    kind: Literal["timestamp"] = field(default="timestamp", init=False)


@dataclass(frozen=True)
class Date:
    kind: Literal["date"] = field(default="date", init=False)


@dataclass(frozen=True)
class Json:
    kind: Literal["json"] = field(default="json", init=False)


@dataclass(frozen=True)
class Blob:
    kind: Literal["blob"] = field(default="blob", init=False)


@dataclass(frozen=True)
class Uuid:
    kind: Literal["uuid"] = field(default="uuid", init=False)


SqlType = Union[Text, Integer, Real, Numeric, Boolean, Timestamp, Date, Json, Blob, Uuid]
