"""Read the hash manifest the way the product does: the union of every file (ADR-0064 Amendment 1)."""
from __future__ import annotations

import json
from pathlib import Path


def manifest_files(gen_state: Path) -> dict[str, dict[str, object]]:
    """file name -> parsed content, for every file in ``.hashes/``."""
    directory = gen_state / ".hashes"
    if not directory.is_dir():
        return {}
    return {
        p.name: json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(directory.glob("*.json"))
    }


def read_manifest(gen_state: Path) -> dict[str, object]:
    """Every recorded entry (the legacy file underneath, package files winning)."""
    merged: dict[str, object] = {}
    legacy = gen_state / ".hashes.json"
    if legacy.exists():
        merged.update(json.loads(legacy.read_text(encoding="utf-8")))
    for entries in manifest_files(gen_state).values():
        merged.update(entries)
    return merged


def record_entry(gen_state: Path, rel: str, digest: str = "0" * 64) -> None:
    """Add a write record for ``rel`` to the root manifest file in ``.hashes/``, the way the
    product files an entry no package claims (ADR-0064 Amendment 1)."""
    from metaobjects.codegen.overwrite_policy import HASHES_DIR, ROOT_MANIFEST

    path = gen_state / HASHES_DIR / ROOT_MANIFEST
    entries = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    entries[rel] = digest
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def has_manifest(gen_state: Path) -> bool:
    return (gen_state / ".hashes.json").exists() or bool(manifest_files(gen_state))
