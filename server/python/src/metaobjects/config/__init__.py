"""Port-neutral `.metaobjects/config.json` reading and source resolution.

Reads the neutral subset this port consumes: `schema_version`, `sources`,
`dependencies`, `scope.include` (explicit-include rule only), `migrate.scope`,
`libraries`, `naming`, `wire`, `rules`/`verify`, `requirements.inherit`, `api`
and `enums` (shape checked; nothing consumed), plus `migrate.dialect` via
`chose_migrate_dialect`. TypeScript-owned keys are ignored rather than modeled,
so a new TS-only key never becomes a four-port change. See
`docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md` §4.
"""
from .dependencies import (
    ARTIFACT_SUFFIX,
    DEPENDENCY_SOURCE_ID_PREFIX,
    DEPS_DIR,
    INTEGRITY_PREFIX,
    LOCK_FILE,
    MANIFEST_FILE,
)
from .neutral_config import DEFAULT_METADATA_DIR, NeutralConfig, read_neutral_config
from .source_resolver import resolve_collection, resolve_sources

__all__ = [
    "ARTIFACT_SUFFIX",
    "DEFAULT_METADATA_DIR",
    "DEPENDENCY_SOURCE_ID_PREFIX",
    "DEPS_DIR",
    "INTEGRITY_PREFIX",
    "LOCK_FILE",
    "MANIFEST_FILE",
    "NeutralConfig",
    "read_neutral_config",
    "resolve_collection",
    "resolve_sources",
]
