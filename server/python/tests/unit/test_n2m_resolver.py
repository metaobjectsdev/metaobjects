"""Unit tests for the metadata-driven M:N runtime resolver (FR-017 Unit 8).

No database: a fake driver returns canned junction + target rows so the resolver
logic (FK derivation + the three resolution modes) is exercised in isolation. The
real Testcontainers Postgres exercise is tests/integration/test_query_scenarios.py
(the shared m2n-*.yaml corpus); these tests pin the resolver's SQL + grouping
semantics without needing Docker.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from metaobjects import load_directory
from metaobjects.runtime import ObjectManager
from metaobjects.runtime.object_manager import SelectResult


def _corpus_canonical() -> Path:
    cur = Path(__file__).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "persistence-conformance" / "canonical"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError("could not find persistence-conformance canonical dir")


class FakeDriver:
    """Returns canned rows per matched SQL substring; records every query."""

    def __init__(self, responses: list[tuple[str, list[dict[str, Any]]]]) -> None:
        self._responses = responses
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    def select(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        self.queries.append((sql, params))
        for needle, rows in self._responses:
            if needle in sql:
                return SelectResult(rows, {})
        return SelectResult([], {})

    def scalar(self, sql: str, params: tuple[Any, ...] = ()) -> Any:  # pragma: no cover
        return None


def _om(responses: list[tuple[str, list[dict[str, Any]]]]) -> tuple[ObjectManager, FakeDriver]:
    root = load_directory(_corpus_canonical()).root
    driver = FakeDriver(responses)
    return ObjectManager(root, driver), driver  # type: ignore[arg-type]


# --- Hetero (Post —tags→ Tag through PostTag) -------------------------------


def test_hetero_resolves_via_derived_fk_fields() -> None:
    om, driver = _om([
        # Junction query: post_tags WHERE postId = 1 → tagIds 10, 20.
        ("post_tags", [{"postId": 1, "tagId": 10}, {"postId": 1, "tagId": 20}]),
        # Target query: tags WHERE id IN (10, 20).
        ("tags", [{"id": 10, "name": "red"}, {"id": 20, "name": "green"}]),
    ])
    result = om.relate("Post", {"id": 1}, "tags")
    assert sorted(r["name"] for r in result) == ["green", "red"]
    # First query hits the junction; filters the SOURCE column only.
    join_sql, join_params = driver.queries[0]
    assert "post_tags" in join_sql
    assert '"postId" = %s' in join_sql
    assert '"tagId"' not in join_sql.split("WHERE", 1)[1]
    assert join_params == (1,)


def test_hetero_no_matches_returns_empty() -> None:
    om, _ = _om([("post_tags", []), ("tags", [])])
    assert om.relate("Post", {"id": 3}, "tags") == []


# --- Directed self-join (Person —following→ Person through Follow) ----------


def test_directed_self_join_uses_source_ref_field() -> None:
    om, driver = _om([
        # @sourceRefField=followerId → query WHERE followerId = 1, collect followeeId.
        ("follows", [{"followerId": 1, "followeeId": 2}, {"followerId": 1, "followeeId": 3}]),
        ("people", [{"id": 2, "name": "Bob"}, {"id": 3, "name": "Carol"}]),
    ])
    result = om.relate("Person", {"id": 1}, "following")
    assert sorted(r["name"] for r in result) == ["Bob", "Carol"]
    join_sql, join_params = driver.queries[0]
    assert "follows" in join_sql
    # Directed: filter ONLY the source-side column (followerId), not symmetric OR.
    assert '"followerId" = %s' in join_sql
    assert " OR " not in join_sql
    assert join_params == (1,)


def test_directed_self_join_direction_matters() -> None:
    # Carol (id=3) follows nobody: junction WHERE followerId=3 returns no rows.
    om, _ = _om([("follows", []), ("people", [])])
    assert om.relate("Person", {"id": 3}, "following") == []


# --- Symmetric self-join (Person —friends→ Person through Friendship) --------


def test_symmetric_unions_both_columns_and_takes_the_other_endpoint() -> None:
    om, driver = _om([
        # Alice (id=1): stored (1,2) forward + (3,1) reverse — both surface.
        ("friendships", [
            {"personAId": 1, "personBId": 2},
            {"personAId": 3, "personBId": 1},
        ]),
        ("people", [{"id": 2, "name": "Bob"}, {"id": 3, "name": "Carol"}]),
    ])
    result = om.relate("Person", {"id": 1}, "friends")
    assert sorted(r["name"] for r in result) == ["Bob", "Carol"]
    # Symmetric: the junction query ORs both FK columns.
    join_sql, join_params = driver.queries[0]
    assert "friendships" in join_sql
    assert '"personAId" = %s' in join_sql
    assert '"personBId" = %s' in join_sql
    assert " OR " in join_sql
    assert join_params == (1, 1)
    # The related ids fetched are the NON-source endpoints: 2 (from (1,2)) and 3
    # (from (3,1)), not the source id 1.
    target_sql, target_params = driver.queries[1]
    assert "people" in target_sql
    assert set(target_params) == {2, 3}
