"""ADR-0038 — reverse-relationship navigation via explicit FK finders (Python port).

For each FK an entity ``E`` holds (an ``identity.reference`` over an FK field
referencing entity ``T``), ``E``'s repository ``Protocol`` gains a finder pair so
``T`` can navigate to its referencing ``E`` rows by calling the finder with a ``T``
id:

    find_<e_plural>_by_<fk_segment>(value)     → single, WHERE <fk> = ?
    find_<e_plural>_by_<fk_segment>_in(values) → batched (anti-N+1), WHERE <fk> IN (…)

The finder name derives from the FK FIELD name (snake_cased, single trailing
``_id`` dropped), which is unique within an entity — so the same-pair case
(``GameSession`` holding THREE FKs to ``Scene``) yields THREE distinct finders, no
collision and no naming attribute. Loads the SHARED cross-port fixture
``fixtures/conformance/reverse-finders-same-pair`` (same metadata every port
gates) and asserts the Python finder shape.

NOT lazy collections (ADR-0038): the Python port only ever emitted M:N navigation,
so there is no lazy reverse 1:N collection to remove; M:N traversal is unchanged.
"""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

import metaobjects.core_types  # noqa: F401 — registers attr/identity/relationship classes
from metaobjects import MetaDataLoader
from metaobjects.apidocs.naming import (
    reverse_finder_fk_segment,
    reverse_finder_fn,
    reverse_finder_in_fn,
)
from metaobjects.codegen.generators.m2m_codegen import build_object_index
from metaobjects.codegen.generators.router_generator import (
    render_router,
    reverse_fks_for,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _find_fixture() -> Path:
    cur = Path(__file__).resolve()
    while cur != cur.parent:
        candidate = (
            cur
            / "fixtures"
            / "conformance"
            / "reverse-finders-same-pair"
            / "input"
            / "meta.game.json"
        )
        if candidate.is_file():
            return candidate
        cur = cur.parent
    raise RuntimeError(
        "Could not locate fixtures/conformance/reverse-finders-same-pair/input/meta.game.json"
    )


def _load_entities() -> dict[str, MetaObject]:
    meta = _find_fixture()
    tmp = Path(tempfile.mkdtemp(prefix="reverse-finders-meta-"))
    try:
        shutil.copy(meta, tmp / meta.name)
        result = MetaDataLoader.from_directory(str(tmp))
        assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]
        return {
            c.name: c
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_ENTITIES = _load_entities()
_INDEX = build_object_index(list(_ENTITIES.values()))


def _game_session_router() -> str:
    out = render_router(_ENTITIES["GameSession"], _INDEX)
    assert out is not None
    return out


# ---------------------------------------------------------------------------
# Naming SSOT — the cross-port-canonical Python spelling.
# ---------------------------------------------------------------------------


def test_fk_segment_drops_single_trailing_id() -> None:
    assert reverse_finder_fk_segment("currentSceneId") == "current_scene"
    assert reverse_finder_fk_segment("authorId") == "author"
    # No trailing Id → snake_case only.
    assert reverse_finder_fk_segment("scene") == "scene"
    # A bare "id" must NOT collapse to "" — keep it.
    assert reverse_finder_fk_segment("id") == "id"


def test_finder_name_shape() -> None:
    assert (
        reverse_finder_fn("GameSession", "currentSceneId")
        == "find_game_sessions_by_current_scene"
    )
    assert (
        reverse_finder_in_fn("GameSession", "currentSceneId")
        == "find_game_sessions_by_current_scene_in"
    )


# ---------------------------------------------------------------------------
# reverse_fks_for — derivation from identity.reference (declaration order).
# ---------------------------------------------------------------------------


def test_reverse_fks_for_game_session() -> None:
    fks = reverse_fks_for(_ENTITIES["GameSession"])
    assert [(f.fk_field, f.target_entity) for f in fks] == [
        ("currentSceneId", "Scene"),
        ("lastOpeningNarrativeSceneId", "Scene"),
        ("transitioningFromSceneId", "Scene"),
        ("playerId", "Player"),
    ]


def test_scene_has_no_reverse_fks() -> None:
    # The finders live on E (the FK holder), not on the referenced T.
    assert reverse_fks_for(_ENTITIES["Scene"]) == []


# ---------------------------------------------------------------------------
# #368 fallout — a dotted @references ("Entity.field" / "Entity.a,b", the
# normative explicit-fields form per spec/metamodel/identity.json) must still
# resolve target_entity to the BARE entity name, not the raw dotted tail.
# Deliberately not the shared reverse-finders-same-pair fixture — this shape
# is narrow enough to inline and doesn't need a new cross-port corpus entry.
# ---------------------------------------------------------------------------


def _load_dotted_reference_entities() -> dict[str, MetaObject]:
    data = {
        "metadata.root": {
            "package": "acme::sport",
            "children": [
                {
                    "object.entity": {
                        "name": "Team",
                        "children": [
                            {"source.rdb": {"@table": "teams"}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"name": "id", "@fields": "id"}},
                        ],
                    }
                },
                {
                    "object.entity": {
                        "name": "Match",
                        "children": [
                            {"source.rdb": {"@table": "matches"}},
                            {"field.long": {"name": "id"}},
                            {"field.long": {"name": "teamFk"}},
                            {"identity.primary": {"name": "id", "@fields": "id"}},
                            {
                                "identity.reference": {
                                    "name": "teamRef",
                                    "@fields": "teamFk",
                                    "@references": "acme::sport::Team.id",
                                }
                            },
                        ],
                    }
                },
            ],
        }
    }
    tmp = Path(tempfile.mkdtemp(prefix="reverse-finders-dotted-"))
    try:
        (tmp / "meta.json").write_text(json.dumps(data))
        result = MetaDataLoader.from_directory(str(tmp))
        assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]
        return {
            c.name: c
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_reverse_fks_for_resolves_bare_target_entity_from_dotted_references() -> None:
    """The USER-VISIBLE symptom this guards: ``reverse_fks_for()`` is a public,
    documented function (its ``ReverseFk.target_entity`` is asserted directly by
    ``test_reverse_fks_for_game_session`` above) whose docstring promises "the bare
    target entity (T)". A dotted ``@references`` used to leak the raw tail
    ("Team.id") into that field instead of bareing it to "Team" -- a correctness
    bug in a tested return value, independent of whether any current caller
    happens to consume the field (see the next test: today, none does)."""
    entities = _load_dotted_reference_entities()
    fks = reverse_fks_for(entities["Match"])
    assert [(f.fk_field, f.target_entity) for f in fks] == [("teamFk", "Team")]


def test_router_reverse_finder_name_unaffected_by_dotted_references() -> None:
    """The generated finder METHOD NAME derives only from the FK-holding entity's
    own name + FK field (never from target_entity), so it was already correct
    with a dotted @references even before the fix above -- the router_generator.py
    bug corrupted a returned data field, not the emitted router source."""
    entities = _load_dotted_reference_entities()
    index = build_object_index(list(entities.values()))
    src = render_router(entities["Match"], index)
    assert src is not None
    assert "def find_matches_by_team_fk(self, team_fk: Any) -> list[Any]: ..." in src
    assert (
        "def find_matches_by_team_fk_in(self, team_fk_values: list[Any]) -> list[Any]: ..."
        in src
    )


# ---------------------------------------------------------------------------
# Same-pair: THREE distinct GameSession→Scene finders — the collision case.
# ---------------------------------------------------------------------------


def test_same_pair_yields_three_distinct_single_finders() -> None:
    src = _game_session_router()
    expected = [
        "find_game_sessions_by_current_scene",
        "find_game_sessions_by_last_opening_narrative_scene",
        "find_game_sessions_by_transitioning_from_scene",
    ]
    for name in expected:
        assert f"def {name}(self," in src
    # Distinct — no collision (a set would shrink if names collided).
    assert len(set(expected)) == 3


def test_same_pair_yields_three_distinct_batched_finders() -> None:
    src = _game_session_router()
    for name in (
        "find_game_sessions_by_current_scene_in",
        "find_game_sessions_by_last_opening_narrative_scene_in",
        "find_game_sessions_by_transitioning_from_scene_in",
    ):
        assert f"def {name}(self," in src


def test_player_fk_also_gets_a_finder_pair() -> None:
    src = _game_session_router()
    assert "def find_game_sessions_by_player(self," in src
    assert "def find_game_sessions_by_player_in(self," in src


# ---------------------------------------------------------------------------
# Finder shapes: single → scalar arg → list[E]; batched → list arg → list[E].
# ---------------------------------------------------------------------------


def test_single_finder_signature_shape() -> None:
    src = _game_session_router()
    assert (
        "def find_game_sessions_by_current_scene(self, current_scene_id: Any) -> list[Any]: ..."
        in src
    )


def test_batched_finder_signature_shape() -> None:
    src = _game_session_router()
    assert (
        "def find_game_sessions_by_current_scene_in(self, current_scene_id_values: list[Any]) -> list[Any]: ..."
        in src
    )


def test_finders_live_on_the_repository_protocol() -> None:
    src = _game_session_router()
    # The finders are part of the framework-free repository Protocol seam (a plain
    # query function the consumer implements), NOT a lazy ORM relationship.
    assert "class GameSessionRepository(Protocol):" in src
    proto_idx = src.index("class GameSessionRepository(Protocol):")
    finder_idx = src.index("def find_game_sessions_by_current_scene(self,")
    assert finder_idx > proto_idx


def test_no_lazy_reverse_collection_navigation() -> None:
    # ADR-0038: reverse nav is explicit finders, never a lazy collection. The Scene
    # router (the referenced T) must not gain a lazy "game_sessions" collection.
    scene_src = render_router(_ENTITIES["Scene"], _INDEX)
    assert scene_src is not None
    assert "game_sessions" not in scene_src
    assert "relationship(" not in scene_src  # SQLAlchemy lazy relationship() — never emitted
