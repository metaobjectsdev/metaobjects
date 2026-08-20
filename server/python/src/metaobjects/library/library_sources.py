"""Resolves :class:`MetaDataSource` instances for the shipped library packages.

Cross-port parity with the TypeScript ``library-sources.ts``: same package names, same
refs, same on-disk-first resolution order.

On-disk first — when the repo-root ``library/`` tree is reachable (a dev checkout or an
installed-from-source layout) a :class:`FileSource` is returned, so edits to the
canonical YAML are picked up without regenerating anything. Embedded fallback — when
that directory is absent (the ordinary wheel-in-site-packages case) the content baked
into :mod:`embedded_library` is used instead.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from metaobjects.loader.sources.file_source import FileSource
from metaobjects.loader.sources.meta_data_source import (
    InMemoryStringSource,
    MetaDataFormat,
    MetaDataSource,
)

from .embedded_library import EMBEDDED_LIBRARY

# Package -> ordered refs, derived from the generated module so that adding a library
# file (which regenerates EMBEDDED_LIBRARY) needs no edit here.
_REFS_BY_PACKAGE: dict[str, list[str]] = {}
for _ref in sorted(EMBEDDED_LIBRARY):
    _pkg = _ref.split("/")[0]
    if _pkg:
        _REFS_BY_PACKAGE.setdefault(_pkg, []).append(_ref)


def known_packages() -> list[str]:
    """The shipped library package names, sorted.

    :func:`library_sources` deliberately skips an unrecognised name (see there), so
    a typo would otherwise surface only as ``ERR_UNRESOLVED_SUPER`` against the
    adopter's own metadata — the wrong place to look. Callers that took the name
    from a human (the CLI reading a config file) validate against this first.
    """
    return sorted(_REFS_BY_PACKAGE)


@lru_cache(maxsize=1)
def _library_dir_on_disk() -> Path | None:
    """The repo-root ``library/`` directory, or None when it is not reachable.

    Identified by the two structural anchors that mark the repo root — a directory
    holding BOTH ``library/`` and ``server/``. Resolved once per process.
    """
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "library").is_dir() and (candidate / "server").is_dir():
            return candidate / "library"
    return None


def library_sources(packages: list[str]) -> list[MetaDataSource]:
    """Sources for the requested shipped-library packages.

    Args:
        packages: package names to include, e.g. ``["ai"]``. An unrecognised name
            contributes no sources rather than raising — a consumer asking for a
            package this version does not ship should not fail to load its own
            metadata.

    Raises:
        ValueError: a known ref has neither an on-disk file nor an embedded entry,
            which means the generated module is stale.
    """
    directory = _library_dir_on_disk()
    out: list[MetaDataSource] = []

    for package in packages:
        for ref in _REFS_BY_PACKAGE.get(package, []):
            if directory is not None:
                path = directory / f"{ref}.yaml"
                if path.is_file():
                    out.append(FileSource(path, format=MetaDataFormat.YAML))
                    continue

            embedded = EMBEDDED_LIBRARY.get(ref)
            if embedded is None:
                raise ValueError(
                    f'library ref "{ref}" (package "{package}") has no on-disk file and no '
                    "embedded entry — the embedded library module is stale; run "
                    "scripts/generate_embedded_library.py"
                )
            out.append(
                InMemoryStringSource(
                    embedded,
                    id=f"library:{ref}.yaml",
                    format=MetaDataFormat.YAML,
                )
            )

    return out
