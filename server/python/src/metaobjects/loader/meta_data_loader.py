"""MetaDataLoader: source-polymorphic loader.

The cross-language Tier-1 loader: takes a list of MetaDataSource impls,
runs parse -> merge -> super-resolve -> validate -> freeze, and returns a
LoadResult { root, errors, warnings }.

Source format (JSON vs YAML) is declared by the source, not sniffed by the
loader. This replaces both the per-file extension switch from the old
free function and the TS FileMetaDataLoader.parseSource override.

The three class-method factories (from_directory / from_uris / from_string)
cover the 99% case; module-level shortcuts in `metaobjects.__init__` wrap
them with Pythonic ergonomics.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from ..core_types import core_provider
from ..errors import ErrorCode, MetaError, ParseError
from ..meta.meta_data import MetaData
from ..meta.meta_root import MetaRoot
from ..parser import ParseResult, parse_document
from ..parser_yaml import parse_yaml
from ..provider import Provider, compose_registry
from ..registry import TypeRegistry
from ..shared.base_types import SUBTYPE_ROOT, TYPE_METADATA
from ..source import CodeSource, ErrorSource, JsonSource, LoaderWarning
from ..super_resolve import resolve_supers
from .merge import merge_roots
from .sources import (
    DirectorySource,
    InMemoryStringSource,
    MetaDataFormat,
    MetaDataSource,
    UriSource,
)
from .validation_passes import run_validations


@dataclass
class LoadResult:
    """The Tier-1 load result. Same field shape across all four ports."""

    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # FR5c — envelope-shaped warnings (e.g. ``WARN_DUPLICATE_DECLARATION``)
    # produced during parse / merge. Distinct from the legacy
    # ``warnings: list[str]`` channel: those flow through the parser /
    # validator surface as plain strings and get wrapped at the loader
    # boundary (or surfaced verbatim by the conformance runner for the
    # expected-warnings.json check); envelope warnings already carry their
    # own ``code`` + ``source``. Mirrors TS ``LoadResult.warnings`` (whose
    # singular channel ships ``LoaderWarning`` envelopes after the FR5c
    # WARN_LEGACY-wrapping pass).
    envelope_warnings: list[LoaderWarning] = field(default_factory=list)

    def get_envelope_warnings(self) -> list[LoaderWarning]:
        """FR5c — accessor mirroring TS ``loader.envelopeWarnings`` /
        Java ``loader.getEnvelopeWarnings()``.

        Returns the in-order list of envelope-shaped warnings (typed with a
        ``code`` + ``source`` envelope) produced during parse / merge. The
        legacy string channel (``self.warnings``) is unchanged.
        """
        return list(self.envelope_warnings)


class MetaDataLoader:
    """Source-polymorphic metadata loader.

    Construct once with a provider list (defaults to ``[core_provider]``);
    call ``.load(sources)`` for arbitrary source combinations, or use the
    ``from_*`` class-method factories for the common cases.
    """

    def __init__(self, providers: list[Provider] | None = None) -> None:
        self._registry: TypeRegistry = compose_registry(
            providers if providers is not None else [core_provider]
        )

    @property
    def registry(self) -> TypeRegistry:
        return self._registry

    # --- core API ------------------------------------------------------

    def load(self, sources: list[MetaDataSource]) -> LoadResult:
        """Parse -> merge -> super-resolve -> validate -> freeze."""
        # Canonical empty root (matches parse_document's seed).
        result = LoadResult(root=MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, ""))
        roots: list[MetaData] = []

        for src in sources:
            parsed = self._parse_source(src, result.errors)
            if parsed is None:
                continue
            result.errors.extend(parsed.errors)
            result.warnings.extend(parsed.warnings)
            # FR5c — collect envelope-shaped warnings from each parse pass.
            # Today these only arrive from merge sites (see merge_roots);
            # the channel is exposed here for future parser-emitted ones.
            result.envelope_warnings.extend(parsed.envelope_warnings)
            if not parsed.errors:
                roots.append(parsed.root)

        if roots:
            # FR5c — merge_roots is the site that emits ERR_MERGE_CONFLICT
            # into errors and WARN_DUPLICATE_DECLARATION into both channels
            # (legacy string + envelope) so the conformance runner's
            # expected-warnings.json check sees the string forms while
            # downstream tooling can consume the envelope shape.
            result.root = merge_roots(
                roots,
                result.errors,
                result.warnings,
                result.envelope_warnings,
            )
            resolve_supers(result.root, result.errors)

        run_validations(
            result.root,
            self._registry,
            result.errors,
            result.warnings,
            envelope_warnings=result.envelope_warnings,
        )
        result.root.freeze()
        return result

    # --- static factories (the 99% case, cross-language consistent) ----

    @classmethod
    def from_directory(
        cls,
        directory: Path | str,
        providers: list[Provider] | None = None,
        exclude: list[str] | None = None,
        recurse: bool = True,
    ) -> LoadResult:
        """Load every JSON/YAML file under ``directory`` (recursive by default)."""
        loader = cls(providers=providers)
        sources = list(
            DirectorySource(directory, exclude=exclude, recurse=recurse).expand()
        )
        return loader.load(sources)

    @classmethod
    def from_uris(
        cls,
        uris: list[str],
        providers: list[Provider] | None = None,
    ) -> LoadResult:
        """Load metadata from a list of URIs (file:// or http(s)://)."""
        loader = cls(providers=providers)
        return loader.load([UriSource(u) for u in uris])

    @classmethod
    def from_string(
        cls,
        content: str,
        format: MetaDataFormat = MetaDataFormat.JSON,
        providers: list[Provider] | None = None,
    ) -> LoadResult:
        """Load metadata from an in-memory string (defaults to JSON)."""
        loader = cls(providers=providers)
        return loader.load([InMemoryStringSource(content, format=format)])

    # --- internals -----------------------------------------------------

    def _parse_source(
        self, src: MetaDataSource, errors: list[MetaError]
    ) -> ParseResult | None:
        """Read a source's content and dispatch to the JSON or YAML parser.

        Returns ``None`` if the source could not be read or its syntax was
        malformed; the caller appends an error and skips this source from
        the merge set.
        """
        # FR5a / ADR-0009 — top-level envelope for the source. Until the parser
        # walk descends, the offending location is the root (`$`). Matches C#
        # Parser.cs:140 — only fall back to CodeSource when there is no source
        # id at all; "<inline>" is a valid source identifier and must yield a
        # JsonSource so envelope formats remain consistent across error sites.
        envelope: ErrorSource = (
            JsonSource(files=(src.id,), json_path="$")
            if src.id
            else CodeSource.DEFAULT
        )

        try:
            text = src.read()
        except OSError as exc:
            errors.append(MetaError(
                str(exc), ErrorCode.ERR_UNKNOWN, src.id, envelope=envelope,
            ))
            return None

        match src.format:
            case MetaDataFormat.YAML:
                try:
                    return parse_yaml(text, self._registry, source=src.id)
                except ParseError as exc:
                    errors.append(MetaError(
                        str(exc), exc.code, src.id, envelope=envelope,
                    ))
                    return None
            case MetaDataFormat.JSON:
                try:
                    doc = json.loads(text)
                except json.JSONDecodeError as exc:
                    errors.append(MetaError(
                        str(exc), ErrorCode.ERR_MALFORMED_JSON, src.id,
                        envelope=envelope,
                    ))
                    return None
                return parse_document(doc, self._registry, source=src.id)
