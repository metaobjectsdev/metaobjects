"""URI-backed MetaDataSource.

Supports ``file://``, ``http://``, and ``https://`` schemes. Format defaults to
extension-derived from the URI path; callers may override.
"""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

from .meta_data_source import MetaDataFormat, MetaDataSource


def _infer_format(uri: str) -> MetaDataFormat:
    path = urlparse(uri).path
    suffix = Path(path).suffix.lower()
    if suffix in (".yaml", ".yml"):
        return MetaDataFormat.YAML
    return MetaDataFormat.JSON


class UriSource(MetaDataSource):
    """A URI-backed source. Lazily fetched on ``read()``."""

    def __init__(
        self,
        uri: str,
        format: MetaDataFormat | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._uri = uri
        self._format = format if format is not None else _infer_format(uri)
        self._timeout = timeout

    @property
    def id(self) -> str:
        return self._uri

    @property
    def format(self) -> MetaDataFormat:
        return self._format

    def read(self) -> str:
        parsed = urlparse(self._uri)
        if parsed.scheme == "file":
            # urlparse splits the leading slashes off the path on file:// URIs.
            return Path(parsed.path).read_text(encoding="utf-8-sig")
        if parsed.scheme in ("http", "https"):
            # Schemes are explicitly allowlisted (file/http/https) above; arbitrary
            # URI handlers (ftp, etc.) reject with ValueError before urlopen is called.
            with urlopen(self._uri, timeout=self._timeout) as resp:  # noqa: S310
                return resp.read().decode("utf-8")
        raise ValueError(
            f"UriSource: unsupported scheme '{parsed.scheme}' on {self._uri}"
        )
