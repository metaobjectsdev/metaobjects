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
