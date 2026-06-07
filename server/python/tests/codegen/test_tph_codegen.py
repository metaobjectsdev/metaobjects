"""FR-017 Tier 4 — TPH codegen coverage gate.

Runs the real generators over the shared TPH model
(``fixtures/api-contract-conformance/tph/meta.json``) and asserts the
table-per-hierarchy structural contract on the EMITTED source. This is the
codegen-side gate the integration tests don't provide: the integration lane
exercises the routes over HTTP, but only this test pins what the entity /
router / filter-allowlist generators actually EMIT for a discriminator base +
its subtypes, so a regression in TPH emission fails here loudly.
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.m2m_codegen import build_object_index
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.generators.tph_plan import (
    is_tph_base,
    is_tph_subtype,
    tph_plan_for,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _find_tph_meta() -> Path:
    cur = Path.cwd().resolve()
    while cur != cur.parent:
        cand = cur / "fixtures" / "api-contract-conformance" / "tph" / "meta.json"
        if cand.is_file():
            return cand
        cur = cur.parent
    raise RuntimeError("could not locate fixtures/api-contract-conformance/tph/meta.json")


@pytest.fixture(scope="module")
def entities() -> dict[str, MetaObject]:
    meta = _find_tph_meta()
    tmp = Path(tempfile.mkdtemp(prefix="tph-codegen-"))
    try:
        shutil.copy(meta, tmp / "meta.json")
        root = MetaDataLoader.from_directory(str(tmp)).root
        return {
            c.name: c
            for c in root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture(scope="module")
def index(entities: dict[str, MetaObject]) -> dict[str, MetaObject]:
    return build_object_index(list(entities.values()))


# ---- TphPlan detection ----------------------------------------------------


def test_plan_detects_base_and_subtypes(entities, index) -> None:
    assert is_tph_base(entities["Auth"], index)
    plan = tph_plan_for(entities["Auth"], index)
    assert plan is not None
    assert plan.discriminator_field == "type"
    assert [(s.entity.name, s.value, s.route_segment) for s in plan.subtypes] == [
        ("BridgeAuth", "Bridge", "bridge"),
        ("CopayAuth", "Copay", "copay"),
        ("PriorAuthAuth", "PriorAuth", "priorauth"),
    ]
    for sub in ("BridgeAuth", "CopayAuth", "PriorAuthAuth"):
        assert is_tph_subtype(entities[sub])
    assert not is_tph_subtype(entities["Auth"])


# ---- entity model: subtype discriminator pin ------------------------------


def test_subtype_pins_discriminator_to_literal(entities, index) -> None:
    src = render_entity_model(entities["BridgeAuth"], index)
    assert "class BridgeAuth(Auth):" in src
    assert 'type: Literal["Bridge"] = "Bridge"' in src
    assert "from typing import Literal" in src
    assert "quantity: int" in src


def test_base_entity_model_is_plain_base(entities, index) -> None:
    # The base is a plain BaseModel; its `type` enum legitimately emits the full
    # Literal["Bridge","Copay","PriorAuth"] (the enum values), but it must NOT carry a
    # single-value discriminator PIN (that's the subtype's job). Python also defers the
    # discriminated-UNION alias (dict runtime; see the entity_model TPH note).
    src = render_entity_model(entities["Auth"], index)
    assert "class Auth(BaseModel):" in src
    for val in ("Bridge", "Copay", "PriorAuth"):
        assert f'type: Literal["{val}"] = "{val}"' not in src


# ---- router: subtypes emit none; base is polymorphic + per-subtype --------


def test_subtype_emits_no_router(entities, index) -> None:
    assert render_router(entities["BridgeAuth"], index) is None


def test_base_router_polymorphic_plus_per_subtype(entities, index) -> None:
    src = render_router(entities["Auth"], index)
    assert src is not None
    # polymorphic base
    assert '@router.get("")' in src
    assert '@router.get("/{auth_id}")' in src
    # no polymorphic create (can't create an abstract base)
    assert '@router.post("", ' not in src
    # per-subtype CRUD at the lowercased segment, discriminator injected from the URL
    for seg, val in (("bridge", "Bridge"), ("copay", "Copay"), ("priorauth", "PriorAuth")):
        assert f'@router.get("/{seg}")' in src
        assert f'@router.post("/{seg}", status_code=status.HTTP_201_CREATED)' in src
        assert f'@router.get("/{seg}/{{auth_id}}")' in src
        assert f'@router.delete("/{seg}/{{auth_id}}"' in src
        assert f'return repo.create("{val}", dto)' in src
    # the per-subtype literal routes are emitted before the polymorphic /{id}
    assert src.index('@router.get("/bridge")') < src.index('@router.get("/{auth_id}")')


# ---- filter allowlist: base folds in subtype-only filterable columns -------


def test_base_allowlist_unions_subtype_fields(entities, index) -> None:
    src = render_filter_allowlist(entities["Auth"], index)
    assert src is not None
    # base filterable fields
    assert '"id"' in src and '"type"' in src and '"reference"' in src
    # subtype-only filterable columns folded into the single-table base allowlist
    assert '"quantity"' in src       # BridgeAuth
    assert '"copayAmount"' in src    # CopayAuth
    assert '"approver"' in src       # PriorAuthAuth
