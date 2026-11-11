"""An enum's ``@default`` is what an untouched record stores, on a live Postgres.

The C# port stored the wrong member here: its entity started at the CLR default, not at
``@default``. This proves the Python port's two write paths. A generated Pydantic model built
without the field holds ``@default``, and persisting its dump stores it. A runtime create that
omits the field leaves it out of the INSERT, so the column default applies.

Three backings: string-stored, an int map with a 0 member (0 is not the default), and an int map
with no 0 member. Each is declared required and nullable. The DDL carries the column defaults
``meta migrate`` writes for this metadata: the member, or its mapped integer under
``@intValueMap``.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import closing
from typing import Any

import pg8000.dbapi as pg8000
import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects import load_string
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.runtime import ObjectManager, PostgresDriver

from .postgres_container import PostgresContainer


def _enum(name: str, values: list[str], default: str, *, required: bool,
          int_map: dict[str, int] | None = None) -> dict[str, Any]:
    node: dict[str, Any] = {"name": name, "@values": values, "@default": default}
    if int_map is not None:
        node["@intValueMap"] = int_map
    if required:
        node["@required"] = True
    return {"field.enum": node}


_META = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {"object.entity": {
                "name": "Setting",
                "children": [
                    {"source.rdb": {"@table": "settings"}},
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "title", "@required": True}},
                    _enum("mode", ["AUTO", "MANUAL"], "MANUAL", required=True),
                    _enum("optMode", ["AUTO", "MANUAL"], "MANUAL", required=False),
                    _enum("rank", ["LOW", "HIGH"], "HIGH", required=True, int_map={"LOW": 0, "HIGH": 1}),
                    _enum("optRank", ["LOW", "HIGH"], "HIGH", required=False, int_map={"LOW": 0, "HIGH": 1}),
                    _enum("band", ["LOW", "HIGH"], "HIGH", required=True, int_map={"LOW": 1, "HIGH": 2}),
                    _enum("optBand", ["LOW", "HIGH"], "HIGH", required=False, int_map={"LOW": 1, "HIGH": 2}),
                    {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                ],
            }},
        ],
    }
}

_DDL = """CREATE TABLE "settings" (
  "id" BIGSERIAL PRIMARY KEY, "title" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'MANUAL', "opt_mode" TEXT DEFAULT 'MANUAL',
  "rank" INTEGER NOT NULL DEFAULT 1, "opt_rank" INTEGER DEFAULT 1,
  "band" INTEGER NOT NULL DEFAULT 2, "opt_band" INTEGER DEFAULT 2)"""

_FIELDS = ("mode", "optMode", "rank", "optRank", "band", "optBand")
_COLUMNS = ("mode", "opt_mode", "rank", "opt_rank", "band", "opt_band")
_DEFAULTED = ("MANUAL", "MANUAL", 1, 1, 2, 2)


def _root() -> Any:
    result = load_string(json.dumps(_META))
    assert result.errors == [], result.errors
    return result.root


def _setting_model() -> Any:
    entity = next(c for c in _root().own_children() if isinstance(c, MetaObject) and c.name == "Setting")
    ns: dict[str, object] = {}
    exec(compile(render_entity_model(entity), "<Setting model>", "exec"), ns)  # noqa: S102
    model: Any = ns["Setting"]
    # exec'd, the module is not in sys.modules: resolve its postponed annotations here.
    model.model_rebuild(_types_namespace=ns)
    return model


@pytest.fixture
def pg() -> Iterator[tuple[ObjectManager, Any]]:
    with PostgresContainer() as container:
        info = container.info()
        with closing(pg8000.connect(
            host=info.host, port=info.port, user=info.user, password=info.password,
            database=info.database,
        )) as conn:
            cur = conn.cursor()
            cur.execute(_DDL)
            conn.commit()
            yield ObjectManager(_root(), PostgresDriver(conn)), conn


def _raw(conn: Any, title: str) -> tuple[Any, ...]:
    cur = conn.cursor()
    cols = ", ".join(f'"{c}"' for c in _COLUMNS)
    cur.execute(f'SELECT {cols} FROM "settings" WHERE "title" = %s', (title,))
    return tuple(cur.fetchone())


def test_a_model_built_without_the_enum_holds_its_default() -> None:
    model = _setting_model()(title="m")
    assert [getattr(model, f) for f in _FIELDS] == ["MANUAL", "MANUAL", "HIGH", "HIGH", "HIGH", "HIGH"]


def test_a_create_that_omits_the_enum_stores_its_default(pg: tuple[ObjectManager, Any]) -> None:
    om, conn = pg
    created = om.create("Setting", {"title": "omitted"})
    assert _raw(conn, "omitted") == _DEFAULTED
    assert created["band"] == "HIGH"


def test_a_model_built_without_the_enum_is_stored_as_its_default(pg: tuple[ObjectManager, Any]) -> None:
    om, conn = pg
    model = _setting_model()(title="model")
    om.create("Setting", model.model_dump(mode="json", exclude={"id"}))
    assert _raw(conn, "model") == _DEFAULTED


def test_an_explicit_first_member_and_null_are_stored_as_set(pg: tuple[ObjectManager, Any]) -> None:
    om, conn = pg
    om.create("Setting", {"title": "set", "mode": "AUTO", "optMode": None, "rank": "LOW",
                          "optRank": None, "band": "LOW", "optBand": None})
    assert _raw(conn, "set") == ("AUTO", None, 0, None, 1, None)
