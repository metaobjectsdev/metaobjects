"""Filesystem loader: discover -> parse -> merge -> freeze."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from ..core_types import core_provider
from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..meta.meta_root import MetaRoot
from ..parser import parse_document
from ..provider import Provider, compose_registry
from ..shared.base_types import SUBTYPE_ROOT, TYPE_METADATA
from ..super_resolve import resolve_supers
from .merge import merge_roots
from .validation_passes import run_validations


@dataclass
class LoadResult:
    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def load_directory(input_dir: str, providers: list[Provider] | None = None) -> LoadResult:
    registry = compose_registry(providers if providers is not None else [core_provider])
    result = LoadResult(root=MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, ""))

    roots: list[MetaData] = []
    files = sorted(Path(input_dir).glob("*.json"), key=lambda p: p.name)
    for path in files:
        try:
            doc = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            result.errors.append(MetaError(str(exc), ErrorCode.ERR_MALFORMED_JSON, path.name))
            continue
        parsed = parse_document(doc, registry, source=path.name)
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
