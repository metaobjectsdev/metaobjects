"""The cross-port collection-URL spelling: the ENTITY NAME snake_cased, then pluralized.

One rule in all five ports. The multi-word and consonant+y axes are also gated
end-to-end by ``fixtures/api-contract-conformance/m2m/`` (the ``PostCategory``
scenario). The ACRONYM case is not — no corpus entity carries one — so it is
pinned here, against the same rule, in every port that owns a naming seam.

``route_path`` deliberately does NOT reuse :func:`metaobjects.apidocs.naming.snake_case`:
that one separates before every capital, which is right for a module name and
would emit ``h_t_t_p_server`` in a URL.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.apidocs.naming import pluralize, reverse_finder_fn, route_path, snake_case

_NAMING_CONFORMANCE_FIXTURE = (
    Path(__file__).parents[4] / "fixtures" / "naming-conformance" / "already-plural-pluralize.json"
)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # Single regular word — every port's old rule already agreed here, which
        # is exactly why four different spellings shipped green.
        ("Author", "authors"),
        ("Post", "posts"),
        ("Tag", "tags"),
        ("Person", "persons"),
        ("Account", "accounts"),
        ("Auth", "auths"),
        # Multi-word: the capitals carry the word boundary, so lowercasing
        # without separating used to yield "postcategorys".
        ("PostCategory", "post_categories"),
        ("OrderSummary", "order_summaries"),
        # consonant + y -> ies; a sibilant takes -es.
        ("Category", "categories"),
        ("Address", "addresses"),
        # Acronym: a run of capitals stays together until the final one that
        # begins a word.
        ("HTTPServer", "http_servers"),
    ],
)
def test_route_path_is_entity_name_snake_cased_then_pluralized(name: str, expected: str) -> None:
    assert route_path(name) == expected


def test_route_path_does_not_reuse_the_module_name_snake_case() -> None:
    """The two snake variants genuinely differ, so this is not a tautology."""
    assert snake_case("HTTPServer") == "h_t_t_p_server"
    assert route_path("HTTPServer") == "http_servers"


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        ("post_category", "post_categories"),
        ("address", "addresses"),
        ("box", "boxes"),
        ("buzz", "buzzes"),
        ("match", "matches"),
        ("dish", "dishes"),
        # A VOWEL before the y takes a plain "s" — "days", never "daies".
        ("day", "days"),
        ("author", "authors"),
    ],
)
def test_pluralize_contract(word: str, expected: str) -> None:
    assert pluralize(word) == expected


# ---- Already-plural detection --------------------------------
#
# An already-plural entity name used to double (program_purchase_stats ->
# program_purchase_statses) in the REST collection segment and the reverse-finder
# names. Mirrors the TS fix in metadata/src/naming.ts exactly (same four-letter
# exclusion set before a final "s").

@pytest.mark.parametrize(
    "word",
    ["stats", "settings", "details", "news", "analytics", "series", "photos"],
)
def test_pluralize_leaves_already_plural_words_unchanged(word: str) -> None:
    assert pluralize(word) == word


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("ProgramPurchaseStats", "program_purchase_stats"),
        ("Settings", "settings"),
    ],
)
def test_route_path_does_not_double_pluralize_an_already_plural_entity_name(
    name: str, expected: str
) -> None:
    assert route_path(name) == expected


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        ("status", "statuses"),
        ("address", "addresses"),
        ("bonus", "bonuses"),
        ("alias", "aliases"),
        ("gas", "gases"),
        # Documented pre-existing imperfection, explicitly out of scope — not "analyses".
        ("analysis", "analysises"),
    ],
)
def test_pluralize_keeps_existing_behavior_for_s_u_i_a_plus_s_endings(
    word: str, expected: str
) -> None:
    assert pluralize(word) == expected


def test_pluralize_documented_known_miss_lens_reads_as_already_plural() -> None:
    # Correct plural is "lenses"; this heuristic is not a dictionary. See
    # pluralize's docstring.
    assert pluralize("lens") == "lens"


def test_reverse_finder_fn_does_not_double_pluralize_an_already_plural_source_entity() -> None:
    assert reverse_finder_fn("ProgramPurchaseStats", "programId") == (
        "find_program_purchase_stats_by_program"
    )


# ---------------------------------------------------------------------------
# fixtures/naming-conformance/ — the shared cross-port data proving every
# port's API-surface pluralizer agrees on the same inputs (the FROZEN legacy
# half of the same fixture is checked in test_fr016_source_name_and_kind_aliases.py,
# against meta_source._pluralize through a loaded entity). See that corpus's
# README.
# ---------------------------------------------------------------------------
_naming_conformance_cases = json.loads(_NAMING_CONFORMANCE_FIXTURE.read_text())["cases"]


@pytest.mark.parametrize(
    "case", _naming_conformance_cases, ids=[c["name"] for c in _naming_conformance_cases]
)
def test_naming_conformance_api_plurals_match(case: dict) -> None:
    assert pluralize(case["name"]) == case["apiPlural"]
