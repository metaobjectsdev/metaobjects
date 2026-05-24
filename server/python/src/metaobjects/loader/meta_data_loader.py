"""Filesystem loader: discover -> parse -> merge -> freeze."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from ..core_types import core_provider
from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..meta.meta_root import MetaRoot
from ..parser import ParseResult, parse_document
from ..parser_yaml import parse_yaml
from ..provider import Provider, compose_registry
from ..registry import TypeRegistry
from ..shared.base_types import SUBTYPE_ROOT, TYPE_METADATA
from ..super_resolve import resolve_supers
from .merge import merge_roots
from .validation_passes import run_validations

# Authoring file formats this loader recognises. JSON is canonical interchange;
# YAML is the sigil-free authoring front-end (ADR-0006).
_JSON_SUFFIXES = (".json",)
_YAML_SUFFIXES = (".yaml", ".yml")


@dataclass
class LoadResult:
    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _parse_file(path: Path, registry: TypeRegistry, errors: list[MetaError]) -> ParseResult | None:
    """Dispatch by file extension to the JSON or YAML front-end.

    Returns None if the file could not even be read/parsed at the syntax level
    (e.g. malformed JSON/YAML); the caller adds the appropriate error to
    *errors* and skips this file from the merge set.
    """
    suffix = path.suffix.lower()
    text = path.read_text(encoding="utf-8-sig")
    if suffix in _YAML_SUFFIXES:
        try:
            return parse_yaml(text, registry, source=path.name)
        except Exception as exc:  # ParseError from parse_yaml carries a code
            code = getattr(exc, "code", ErrorCode.ERR_MALFORMED_YAML)
            errors.append(MetaError(str(exc), code, path.name))
            return None
    # Default: JSON.
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        errors.append(MetaError(str(exc), ErrorCode.ERR_MALFORMED_JSON, path.name))
        return None
    return parse_document(doc, registry, source=path.name)


def load_directory(input_dir: str, providers: list[Provider] | None = None) -> LoadResult:
    registry = compose_registry(providers if providers is not None else [core_provider])
    result = LoadResult(root=MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, ""))

    # Deterministic ordinal-filename order over JSON + YAML / YML.
    # Overlay merge is order-sensitive (last-writer-wins on attr conflicts), so
    # the scan must not depend on filesystem readdir order. Matches the TS
    # FileMetaDataLoader.loadDirectory contract.
    accepted = _JSON_SUFFIXES + _YAML_SUFFIXES
    files = sorted(
        (p for p in Path(input_dir).iterdir() if p.is_file() and p.suffix.lower() in accepted),
        key=lambda p: p.name,
    )

    roots: list[MetaData] = []
    for path in files:
        parsed = _parse_file(path, registry, result.errors)
        if parsed is None:
            continue
        result.errors.extend(parsed.errors)
        result.warnings.extend(parsed.warnings)
        if not parsed.errors:
            roots.append(parsed.root)

    if roots:
        result.root = merge_roots(roots, result.errors)
        resolve_supers(result.root, result.errors)

    run_validations(result.root, registry, result.errors, result.warnings)
    result.root.freeze()
    return result
