"""Bridge the corpus to the Python loader."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from metaobjects import LoadResult, MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.documentation import doc_provider
from metaobjects.meta.meta_data import MetaData
from metaobjects.provider import Provider
from metaobjects.serializer_json import canonical_serialize
from metaobjects.source.error_source import (
    CodeSource,
    JsonSource,
    MergedSource,
    ResolvedSource,
    YamlSource,
)

# Provider-id -> provider. The fixture corpus names providers by their stable
# id (e.g. "metaobjects-core-types"). load_fixture_* resolve those ids to the
# actual provider objects to compose a registry. Parity with the TS and C#
# adapter PROVIDERS maps.
_PROVIDER_MAP: dict[str, Provider] = {
    core_provider.id: core_provider,                # "metaobjects-core-types"
    doc_provider.id: doc_provider,                  # "metaobjects-documentation"
}


def _resolve_providers(provider_ids: Optional[Iterable[str]]) -> list[Provider]:
    """Map fixture-declared provider ids to provider objects.

    When ``provider_ids`` is None, falls back to the legacy default
    (``[core_provider, doc_provider]``) — pre-rc.3 behavior. An unknown id
    raises (parity with the TS / C# adapters).
    """
    if provider_ids is None:
        return [core_provider, doc_provider]
    resolved: list[Provider] = []
    for pid in provider_ids:
        p = _PROVIDER_MAP.get(pid)
        if p is None:
            raise ValueError(f'Unknown provider id "{pid}"')
        resolved.append(p)
    return resolved


@dataclass(frozen=True)
class ErrorEnvelopeRecord:
    """FR5a / ADR-0009 — cross-port envelope record surfaced by the adapter.

    Mirrors the TS ``ErrorEnvelopeRecord`` shape so the Python conformance
    runner can do the same per-error envelope assertion the TS runner does.
    FR5d — ``referrer`` and ``target`` are populated for ``format=resolved``
    envelopes (reference-resolution errors).
    """
    code: str
    format: str
    files: tuple[str, ...]
    json_path: Optional[str]
    referrer: Optional[str] = None
    target: Optional[str] = None


def _relativize(file_path: str, input_dir: Path) -> str:
    """Make a file path relative to the fixture's input directory."""
    p = Path(file_path)
    try:
        rel = p.absolute().relative_to(input_dir.absolute())
        return str(rel).replace("\\", "/")
    except ValueError:
        # Already relative or under a different root.
        return file_path.replace("\\", "/")


def _build_envelope_from_source(code: str, env, input_dir: Path) -> ErrorEnvelopeRecord:
    """Build an envelope record from a (code, ErrorSource) pair.

    Shared between error-side and warning-side normalization so both channels
    produce structurally identical records (mirrors the TS adapter's single
    normalization path).
    """
    def rel_files() -> tuple[str, ...]:
        return tuple(_relativize(f, input_dir) for f in env.files)

    if isinstance(env, JsonSource):
        return ErrorEnvelopeRecord(code, "json", rel_files(), env.json_path)
    if isinstance(env, YamlSource):
        return ErrorEnvelopeRecord(code, "yaml", rel_files(), env.json_path)
    if isinstance(env, MergedSource):
        return ErrorEnvelopeRecord(code, "merged", rel_files(), env.json_path)
    if isinstance(env, ResolvedSource):
        # FR5d — surface referrer + target so the cross-port runner can assert them.
        return ErrorEnvelopeRecord(
            code, "resolved", rel_files(), env.json_path,
            referrer=env.referrer, target=env.target,
        )
    if isinstance(env, CodeSource):
        return ErrorEnvelopeRecord(code, "code", (), None)
    # No envelope — synthesize a minimal root-level shape.
    return ErrorEnvelopeRecord(code, "json", (), "$")


def _build_envelope(err, input_dir: Path) -> ErrorEnvelopeRecord:
    """Convert a Python MetaError into the cross-port envelope record."""
    return _build_envelope_from_source(err.code.name, err.envelope, input_dir)


def _build_warning_envelope(warn, input_dir: Path) -> ErrorEnvelopeRecord:
    """Convert a Python LoaderWarning into the cross-port envelope record.

    FR5c-finalize — mirrors :func:`_build_envelope` so the cross-port runner
    can assert warning envelopes the same way it asserts error envelopes.
    """
    return _build_envelope_from_source(warn.code, warn.source, input_dir)


def load_fixture(
    input_dir: Path,
    provider_ids: Optional[Iterable[str]] = None,
) -> tuple[list[str], list[str], str]:
    """Return (error_codes, warnings, canonical_serialization).

    ``provider_ids`` — declared by the fixture's providers.json. ``None``
    preserves pre-rc.3 behavior (``[core_provider, doc_provider]``).
    """
    providers = _resolve_providers(provider_ids)
    result = MetaDataLoader.from_directory(input_dir, providers=providers)
    codes = [e.code.name for e in result.errors]
    canonical = canonical_serialize(result.root)
    return codes, list(result.warnings), canonical


def load_fixture_with_envelopes(
    input_dir: Path,
    provider_ids: Optional[Iterable[str]] = None,
) -> tuple[
    list[str],
    list[ErrorEnvelopeRecord],
    list[str],
    list[ErrorEnvelopeRecord],
    str,
]:
    """Return (error_codes, error_envelopes, warnings, warning_envelopes, canonical).

    FR5a / ADR-0009 — provides the per-error envelope alongside the legacy
    code-list so the conformance runner can do the envelope assertion.

    FR5c-finalize — additionally provides per-warning envelopes (same
    normalization as the error side) so the runner can assert warning
    envelope shape when ``expected-errors.json#warnings[]`` declares it.

    ``provider_ids`` — declared by the fixture's providers.json. ``None``
    preserves pre-rc.3 behavior (``[core_provider, doc_provider]``).
    """
    providers = _resolve_providers(provider_ids)
    result = MetaDataLoader.from_directory(input_dir, providers=providers)
    codes = [e.code.name for e in result.errors]
    envelopes = [_build_envelope(e, input_dir) for e in result.errors]
    warning_envelopes = [
        _build_warning_envelope(w, input_dir) for w in result.get_envelope_warnings()
    ]
    canonical = canonical_serialize(result.root)
    return codes, envelopes, list(result.warnings), warning_envelopes, canonical


def load_fixture_result(
    input_dir: Path,
    provider_ids: Optional[Iterable[str]] = None,
) -> LoadResult:
    """Return the full LoadResult (including the root node) for script.json checks.

    ``provider_ids`` — declared by the fixture's providers.json. ``None``
    preserves pre-rc.3 behavior (``[core_provider, doc_provider]``).
    """
    providers = _resolve_providers(provider_ids)
    return MetaDataLoader.from_directory(input_dir, providers=providers)
