"""Port-neutral `.metaobjects/config.json` reading and source resolution.

Reads only the NEUTRAL SUBSET (`schema_version`, `sources`). The file also
carries TypeScript-owned keys; those are ignored rather than modeled, so a new
TS-only key never becomes a four-port change. See
`docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md` §4.
"""
from .neutral_config import DEFAULT_METADATA_DIR, NeutralConfig, read_neutral_config
from .source_resolver import resolve_collection, resolve_sources

__all__ = [
    "DEFAULT_METADATA_DIR",
    "NeutralConfig",
    "read_neutral_config",
    "resolve_collection",
    "resolve_sources",
]
