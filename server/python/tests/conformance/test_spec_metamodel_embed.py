"""FR-033 byte-identity gate — the embedded ``metaobjects/spec_metamodel/*.json``
copies must be byte-for-byte identical to the repo-root ``spec/metamodel/`` source.

The descriptions are the cross-port single source of truth; a silently-stale
embedded copy would let the Python port drift from TS undetected. The copies are
committed into the package (so the wheel ships them, AOT-safe); this gate is the
backstop that catches a drifted copy (refresh with
``cp spec/metamodel/*.json server/python/src/metaobjects/spec_metamodel/``).
"""
from __future__ import annotations

from importlib import resources
from pathlib import Path

from metaobjects.spec_metamodel import SPEC_FILES, SpecMetamodelReader


def _repo_root_spec_dir() -> Path:
    """Walk up to the repo root and locate spec/metamodel (no hardcoded paths)."""
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "spec" / "metamodel"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate spec/metamodel by walking up from " + str(here))


def test_embedded_spec_files_match_repo_root_source_byte_for_byte() -> None:
    spec_dir = _repo_root_spec_dir()
    pkg = resources.files("metaobjects.spec_metamodel")
    for name in SPEC_FILES:
        embedded = (pkg / name).read_text(encoding="utf-8").replace("\r\n", "\n")
        source = (spec_dir / name).read_text(encoding="utf-8").replace("\r\n", "\n")
        assert embedded == source, (
            f"Embedded spec_metamodel/{name} diverges from the repo-root "
            f"spec/metamodel/{name} (FR-033 single-source rule). Re-copy the file."
        )


def test_repo_root_and_embedded_file_sets_match() -> None:
    spec_dir = _repo_root_spec_dir()
    repo_files = {p.name for p in spec_dir.glob("*.json")}
    assert repo_files == set(SPEC_FILES), (
        "SPEC_FILES drifted from the repo-root spec/metamodel/ directory listing."
    )


def test_reader_loads_every_embedded_file() -> None:
    reader = SpecMetamodelReader.load()
    # The documentation common-attr doc resolves.
    assert reader.common_attr_doc("description") is not None
    # A core type doc resolves.
    assert reader.type_doc("field", "string") is not None
    # An own-subtype attr doc resolves.
    assert reader.attr_doc("field", "string", "maxLength") is not None
    # An extends-block attr (db.json @column on field.*) resolves on a concrete subtype.
    assert reader.attr_doc("field", "string", "column") is not None
    # A base-subtype-inherited attr (field.base @required) resolves on a concrete subtype.
    assert reader.attr_doc("field", "string", "required") is not None
