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


def test_docs_route_path_and_body_are_the_cross_port_contract() -> None:
    from metaobjects import META_DOCS_ROUTE_PATH, meta_docs_json
    from tests.docs_view_support import corpus, load_case

    assert META_DOCS_ROUTE_PATH == "/_meta/docs"
    expected = (corpus() / "model-alone" / "expected.json").read_text(encoding="utf-8")
    assert meta_docs_json(load_case("model-alone")) == expected


def test_docs_etag_and_if_none_match() -> None:
    from metaobjects import meta_docs, meta_docs_etag
    from tests.docs_view_support import load_case

    # FNV-1a over UTF-16 code units: the empty body hashes to the offset basis.
    assert meta_docs_etag("") == '"0-811c9dc5"'
    assert meta_docs_etag("a") == '"1-e40c292c"'
    assert meta_docs_etag("\U0001f600") == meta_docs_etag("😀".encode("utf-16", "surrogatepass").decode("utf-16"))
    docs = meta_docs(load_case("model-alone"))
    assert docs.etag == meta_docs_etag(docs.body)
    assert docs.matches(docs.etag) and docs.matches("*") and docs.matches("W/" + docs.etag)
    assert docs.matches('"x", ' + docs.etag)
    assert not docs.matches('"other"') and not docs.matches(None) and not docs.matches("")
