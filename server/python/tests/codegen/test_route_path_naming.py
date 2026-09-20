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

import pytest

from metaobjects.apidocs.naming import pluralize, route_path, snake_case


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
