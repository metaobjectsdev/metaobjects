"""UI-1 — GET /_meta contract: the Python `meta_json` helper.

Loads the shared `extends-abstract-base` conformance fixture (real object-level
inheritance: `Subscriber extends acme::BaseEntity`, and `BaseEntity` declares
`createdAt`) and asserts `meta_json` returns the EFFECTIVE canonical
serialization — the one that inlines inherited members — never the raw one.
"""
from __future__ import annotations

from pathlib import Path

from metaobjects import META_ROUTE_PATH, MetaDataLoader, meta_json
from metaobjects.core_types import core_provider
from metaobjects.serializer_json import canonical_serialize, canonical_serialize_effective


def _fixtures_root() -> Path:
    """Walk up from this file to find the repo-shared `fixtures/conformance` dir
    (mirrors `tests/conformance/corpus.py`'s `corpus_root()` — no hardcoded path)."""
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/conformance from " + str(here))


def load_extends_fixture():
    """Load `fixtures/conformance/extends-abstract-base/input` and assert a
    clean load (ADR-0023: a fixture with no `expected-errors.json` must load
    with zero errors)."""
    input_dir = _fixtures_root() / "extends-abstract-base" / "input"
    result = MetaDataLoader.from_directory(input_dir, providers=[core_provider])
    assert not result.errors, result.errors
    return result.root


def test_meta_route_path_is_the_cross_port_contract_value() -> None:
    assert META_ROUTE_PATH == "/_meta"


def test_meta_json_returns_the_effective_canonical_serialization() -> None:
    root = load_extends_fixture()
    assert meta_json(root) == canonical_serialize_effective(root)


def test_meta_json_inlines_a_member_inherited_via_extends() -> None:
    """The real discriminator: `createdAt` is declared only on `BaseEntity`, not
    on `Subscriber`. `Subscriber` is the last top-level object in the fixture's
    document, in both raw and effective form, so slicing from its `"name"` key
    to end-of-document isolates exactly its own block (own children only, raw;
    the super-chain-merged set, effective) without picking up `BaseEntity`'s
    unrelated `createdAt` declaration earlier in the same document.

    `createdAt` must appear in that slice for the EFFECTIVE serialization
    (proving the super-chain merge ran) and must be ABSENT from that slice for
    the RAW one — which is exactly what would fail if `meta_json` ever called
    `canonical_serialize` instead of `canonical_serialize_effective`.
    """
    root = load_extends_fixture()

    effective = meta_json(root)
    raw = canonical_serialize(root)

    effective_subscriber = effective[effective.index('"name": "Subscriber"'):]
    raw_subscriber = raw[raw.index('"name": "Subscriber"'):]

    assert "createdAt" in effective_subscriber
    assert "createdAt" not in raw_subscriber
