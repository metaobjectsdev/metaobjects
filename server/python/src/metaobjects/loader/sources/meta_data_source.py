"""MetaDataSource abstract base + InMemoryStringSource impl.

Tier-1 contract: identity (for MetaError.location), declared format, and a
read() that returns decoded UTF-8 content.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from enum import Enum


class MetaDataFormat(str, Enum):
    """Authoring format vocabulary. Cross-language Tier 1: lowercase strings."""

    JSON = "json"
    YAML = "yaml"


class MetaDataSource(ABC):
    """A source of metadata content.

    Implementations declare identity + format up front; bytes may be read
    eagerly or lazily (the loader treats `read()` as decoded text).
    """

    @property
    @abstractmethod
    def id(self) -> str:
        """Stable identity used in MetaError.location (e.g. file name, URI, ``<inline>``)."""

    @property
    @abstractmethod
    def format(self) -> MetaDataFormat:
        """Declared authoring format. Source-declared, never sniffed by the loader."""

    @abstractmethod
    def read(self) -> str:
        """Return the decoded text content."""


class InMemoryStringSource(MetaDataSource):
    """In-memory string source; no I/O.

    Default identity is ``<inline>``; callers may pass a more descriptive id
    (e.g. ``<test:foo>``) — it surfaces in MetaError.location.
    """

    def __init__(
        self,
        content: str,
        id: str = "<inline>",
        format: MetaDataFormat = MetaDataFormat.JSON,
    ) -> None:
        self._content = content
        self._id = id
        self._format = format

    @property
    def id(self) -> str:
        return self._id

    @property
    def format(self) -> MetaDataFormat:
        return self._format

    def read(self) -> str:
        return self._content
