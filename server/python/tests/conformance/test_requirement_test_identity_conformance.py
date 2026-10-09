"""Cross-port requirement-test identity corpus — fixtures/requirement-test-identity-conformance/.

Every port generates one test per requirement, in its own language and framework, and the
generated files are free to differ. What may not differ is which tests a ledger yields, what
each is called, whether it is skipped, the digest of the claim it tests, and what a project's
filter is shown. This runner holds the Python port to the corpus; TypeScript is the reference
(``requirement-test-identity-conformance.test.ts``), and a committed ``expected.json`` is never
edited to make this port pass.

Every case is LOADED strict first, in file-name order, so "this model loads today" is proven by
the fixture rather than asserted in prose.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

import pytest

from metaobjects import MetaDataLoader
from metaobjects.codegen.requirement_walk import (
    RequirementTestIdentity,
    RequirementView,
    requirement_test_identities,
    witness_key_collisions,
    witness_key_of,
)


def _corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "requirement-test-identity-conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/requirement-test-identity-conformance from " + str(here))


CORPUS = _corpus_root()
FIXTURES = sorted(p.name for p in CORPUS.iterdir() if p.is_dir())

#: The whole of ``options.json``. A key outside this list is refused rather than ignored: a
#: misspelt ``filter`` would otherwise run the case under the default filter and pin the wrong
#: set of tests in every port.
OPTION_KEYS = {"grain", "filter"}

Predicate = Callable[[RequirementView], bool]

#: The corpus's closed list of filters: exactly eight rows, in the README's order. A case NAMES
#: one and every port's runner holds this table in its own language.
FILTERS: dict[str, Predicate] = {
    "all": lambda r: True,
    "architectural": lambda r: r.sub_type == "architectural",
    "live": lambda r: r.status == "live",
    "level-5": lambda r: r.level == 5,
    "unlevelled": lambda r: r.level is None,
    "package-acme-shop": lambda r: r.package == "acme::shop",
    "path-under-Shop": lambda r: r.path == "Shop" or r.path.startswith("Shop."),
    "claims-entity": lambda r: "object.entity" in r.implemented_by_types,
}


def _read_options(case_dir: Path) -> dict[str, Any]:
    file = case_dir / "options.json"
    if not file.exists():
        return {}
    options: dict[str, Any] = json.loads(file.read_text(encoding="utf-8"))
    unknown = sorted(set(options) - OPTION_KEYS)
    if unknown:
        raise AssertionError(f"{file}: unknown option(s) {', '.join(unknown)}")
    return options


def _filter_named(name: str) -> Predicate:
    try:
        return FILTERS[name]
    except KeyError:
        raise AssertionError(f"unknown filter '{name}'. The corpus names: {', '.join(FILTERS)}") from None


def _record(t: RequirementTestIdentity) -> dict[str, Any]:
    """The corpus's JSON shape: ``witnessKey``, not ``witness_key``."""
    return {
        "package": t.package,
        "path": t.path,
        "unit": t.unit,
        "id": t.id,
        "witnessKey": t.witness_key,
        "status": t.status,
        "skip": t.skip,
        "digest": t.digest,
    }


def _by_id(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(records, key=lambda r: r["id"])


def _sorted_pairs(pairs: list[Any]) -> list[list[str]]:
    return sorted(sorted(p) for p in pairs)


def _documented_cases() -> list[str]:
    readme = (CORPUS / "README.md").read_text(encoding="utf-8")
    section = next((s for s in re.split(r"^## ", readme, flags=re.M) if s.startswith("Cases\n")), None)
    assert section is not None, "README.md has no '## Cases' section"
    return re.findall(r"^\| `([^`]+)` \|", section, flags=re.M)


def load_case(name: str):
    """Load ``input/`` of one case strict, in file-name order, asserting zero load errors."""
    from metaobjects.loader.sources import FileSource

    files = sorted((CORPUS / name / "input").iterdir(), key=lambda p: p.name)
    result = MetaDataLoader(strict=True).load([FileSource(p) for p in files])
    assert [str(e) for e in result.errors] == []
    return result.root


def test_found_fixtures() -> None:
    assert FIXTURES, "fixtures/requirement-test-identity-conformance/ discovered no fixture directories"


def test_every_case_on_disk_is_documented_in_the_readme_and_nothing_else_is() -> None:
    assert sorted(_documented_cases()) == FIXTURES


def test_the_filter_table_has_exactly_the_eight_named_rows() -> None:
    readme = (CORPUS / "README.md").read_text(encoding="utf-8")
    section = readme.split("### The named filters", 1)[1].split("- `level` is **absent**", 1)[0]
    rows = [name for name in re.findall(r"^\| `([^`]+)` \|", section, flags=re.M) if name != "filter"]
    assert sorted(rows) == sorted(FILTERS)
    assert len(FILTERS) == 8


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture(name: str) -> None:
    case_dir = CORPUS / name
    expected = json.loads((case_dir / "expected.json").read_text(encoding="utf-8"))
    options = _read_options(case_dir)
    root = load_case(name)

    # Each option is passed only when the case sets it, so a case without one runs the
    # port's own default, which is itself part of what the corpus pins.
    kwargs: dict[str, Any] = {}
    if "grain" in options:
        kwargs["grain"] = options["grain"]
    if "filter" in options:
        kwargs["filter"] = _filter_named(options["filter"])
    tests = requirement_test_identities(root, **kwargs)

    assert _by_id([_record(t) for t in tests]) == _by_id(expected["tests"])
    assert _sorted_pairs(witness_key_collisions(tests)) == _sorted_pairs(expected["collisions"])


def test_the_witness_key_class_is_ascii_letters_and_digits_only() -> None:
    # Pinned here and not by the corpus: no input declares a non-ASCII name, because the
    # loaders are not known to agree on one. `str.isalnum()` and `\w` both keep the accent.
    assert witness_key_of("acme::shop::Café.Réglé", "*") == "req_acme_shop_Caf_R_gl_"
    # An underscore is outside the class, so a doubled one collapses.
    assert witness_key_of("Orders__Recorded", "*") == "req_Orders_Recorded"
    assert witness_key_of("acme::shop::Orders.Recorded", "object.entity") == (
        "req_acme_shop_Orders_Recorded__object_entity"
    )


def test_an_unknown_grain_is_refused_by_the_identity_function_even_over_an_empty_ledger() -> None:
    root = load_case("default-filter")
    with pytest.raises(ValueError, match="unknown requirement-test grain 'hybrid'"):
        requirement_test_identities(root, grain="hybrid", filter=lambda _view: False)
