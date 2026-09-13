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

import json
from functools import lru_cache
from pathlib import Path

from metaobjects.loader.sources.file_source import FileSource
from metaobjects.loader.sources.meta_data_source import (
    InMemoryStringSource,
    MetaDataFormat,
    MetaDataSource,
)

from .embedded_library import EMBEDDED_LIBRARY, EMBEDDED_LIBRARY_MANIFESTS

#: Library name -> its manifest's LAYERS: layer token -> that layer's ordered refs. The
#: CORE layer's token is the empty string.
#:
#: Read from the embedded ``library.json`` manifests, not derived from the ref names.
#: This used to be package-granular — every ref under a library came back for a bare
#: ``"ai"`` — which under the layered design (FR-043 Amendment 1) would hand an adopter
#: the db layer they did not ask for, and with it a migration proposing tables.
_LAYERS_BY_LIBRARY: dict[str, dict[str, list[str]]] = {
    _name: {
        _layer: list(_spec.get("refs", []))
        for _layer, _spec in json.loads(_text).get("layers", {}).items()
    }
    for _name, _text in sorted(EMBEDDED_LIBRARY_MANIFESTS.items())
}

#: Every shipped library's parsed manifest, keyed by name.
LIBRARY_MANIFESTS: dict[str, dict] = {
    _name: json.loads(_text) for _name, _text in sorted(EMBEDDED_LIBRARY_MANIFESTS.items())
}


#: The prefix every library source id carries — the discriminator for "did a shipped
#: library contribute this file", and the reason the id is stable rather than derived
#: from a path (see :func:`library_file_id`).
LIBRARY_FILE_ID_PREFIX = "library:"


def library_file_id(ref: str) -> str:
    """The source id a library file loads under, in every build —
    ``library:iam/model.yaml``.

    Stable rather than path-derived so a library node's ADR-0009 provenance envelope
    reads the same from a checkout and from an installed wheel, carries no absolute
    path, and cannot be confused with an adopter file sharing a basename."""
    return f"{LIBRARY_FILE_ID_PREFIX}{ref}.yaml"


def is_library_file_id(source_id: str) -> bool:
    """True when a source id names a file a shipped library contributed."""
    return source_id.startswith(LIBRARY_FILE_ID_PREFIX)


def split_layer_token(token: str) -> tuple[str, str]:
    """Split a selection token into ``(library, layer)``.

    ``"iam"`` -> ``("iam", "")``; ``"iam/db"`` -> ``("iam", "db")``. Only the FIRST
    separator is meaningful, so a typo stays a typo rather than resolving to a prefix.
    """
    library, sep, layer = token.partition("/")
    return (library, layer if sep else "")


def known_packages() -> list[str]:
    """The shipped library names, sorted.

    :func:`library_sources` deliberately skips an unrecognised name (see there), so
    a typo would otherwise surface only as ``ERR_UNRESOLVED_SUPER`` against the
    adopter's own metadata — the wrong place to look. Callers that took the name
    from a human (the CLI reading a config file) validate against this first.
    """
    return sorted(_LAYERS_BY_LIBRARY)


def known_tokens() -> list[str]:
    """Every selection token this build accepts, sorted — what a config error prints.

    TOKENS, not library names, so an adopter who typed ``iam/database`` is shown
    ``iam/db`` rather than only the half they got right.
    """
    return sorted(
        name if layer == "" else f"{name}/{layer}"
        for name, layers in _LAYERS_BY_LIBRARY.items()
        for layer in layers
    )


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

    Layer-granular: a token is ``<library>`` or ``<library>/<layer>``, and the CORE
    layer is the bare name. ``"iam/db"`` IMPLIES ``"iam"`` — a db layer is nothing but
    ``overlay: true`` redeclarations, and an overlay whose target was never declared is
    ``ERR_OVERLAY_NO_TARGET``, so implying it is the only coherent reading.

    Args:
        packages: selection tokens, e.g. ``["iam", "iam/db"]``. An unrecognised token
            contributes no sources rather than raising — a consumer asking for a
            library this version does not ship should not fail to load its own
            metadata. A token whose LAYER is unknown is dropped WHOLE rather than
            reduced to its core: implying the core from an invalid layer would answer a
            mistyped ``iam/database`` with an inert core and no tables.

    Raises:
        ValueError: a known ref has neither an on-disk file nor an embedded entry,
            which means the generated module is stale.
    """
    directory = _library_dir_on_disk()
    out: list[MetaDataSource] = []

    wanted = [
        (lib, layer)
        for lib, layer in (split_layer_token(t) for t in packages)
        if layer in _LAYERS_BY_LIBRARY.get(lib, {})
    ]

    # Core layers FIRST, across every requested library, so a db layer named before its
    # core in the config still parses after it.
    refs: list[str] = []
    seen: set[str] = set()
    for lib, _ in wanted:
        for ref in _LAYERS_BY_LIBRARY[lib][""]:
            if ref not in seen:
                seen.add(ref)
                refs.append(ref)
    for lib, layer in wanted:
        if layer == "":
            continue
        for ref in _LAYERS_BY_LIBRARY[lib][layer]:
            if ref not in seen:
                seen.add(ref)
                refs.append(ref)

    for ref in refs:
        if directory is not None:
            path = directory / f"{ref}.yaml"
            if path.is_file():
                # The SAME id the embedded branch uses: a path-derived id would make a
                # library node's error envelope differ between a checkout and an
                # installed wheel, and would collide with an adopter file of the same
                # basename.
                out.append(
                    FileSource(path, id=library_file_id(ref), format=MetaDataFormat.YAML)
                )
                continue

        embedded = EMBEDDED_LIBRARY.get(ref)
        if embedded is None:
            raise ValueError(
                f'library ref "{ref}" has no on-disk file and no '
                "embedded entry — the embedded library module is stale; run "
                "scripts/generate_embedded_library.py"
            )
        out.append(
            InMemoryStringSource(
                embedded,
                id=library_file_id(ref),
                format=MetaDataFormat.YAML,
            )
        )

    return out
