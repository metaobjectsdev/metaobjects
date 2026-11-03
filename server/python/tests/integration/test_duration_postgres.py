"""field.duration on a live Postgres through the ObjectManager: a native ``interval`` column,
bound and read as a ``timedelta`` by pg8000, orders and range-filters as a span (sort plus
gt / gte / lt / lte), and a negative or more-than-a-day value round-trips canonically."""
from __future__ import annotations

import datetime as dt
import json
from contextlib import closing
from typing import Any

import pg8000.dbapi as pg8000

from metaobjects import load_string
from metaobjects.codegen.runtime.duration_wire import format_duration
from metaobjects.naming import NamingRules
from metaobjects.runtime import ObjectManager, PostgresDriver

from .postgres_container import PostgresContainer

_META = {
    "metadata.root": {
        "package": "acme::ops",
        "children": [
            {
                "object.entity": {
                    "name": "Hold",
                    "children": [
                        {"source.rdb": {"@table": "holds"}},
                        {"field.long": {"name": "id"}},
                        {"field.duration": {"name": "holdFor"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            }
        ],
    }
}


def _spans(rows: list[dict[str, Any]]) -> list[str | None]:
    return [None if r["holdFor"] is None else format_duration(r["holdFor"]) for r in rows]


def test_postgres_orders_and_range_filters_a_duration() -> None:
    root: Any = load_string(json.dumps(_META)).root
    root.naming = NamingRules(columns="literal")
    with PostgresContainer() as pg:
        info = pg.info()
        with closing(pg8000.connect(
            host=info.host, port=info.port, user=info.user, password=info.password, database=info.database,
        )) as conn:
            cur = conn.cursor()
            cur.execute('CREATE TABLE "holds" ("id" BIGSERIAL PRIMARY KEY, "holdFor" INTERVAL)')
            conn.commit()
            om = ObjectManager(root, PostgresDriver(conn))
            for d in ["PT2H", "-PT1M30S", "PT90M", "PT45S", "P1D", "PT0S", "PT256204779H"]:
                om.create("Hold", {"holdFor": d})
            om.create("Hold", {})

            asc = om.find_many("Hold", sort=[("holdFor", "asc")])
            assert _spans(asc) == [
                "-PT1M30S", "PT0S", "PT45S", "PT1H30M", "PT2H", "PT24H", "PT256204779H", None,
            ]
            ranged = om.find_many("Hold", {"holdFor": {"gt": "PT0S", "lte": "PT120M"}}, sort=[("holdFor", "desc")])
            assert _spans(ranged) == ["PT2H", "PT1H30M", "PT45S"]
            assert _spans(om.find_many("Hold", {"holdFor": {"lt": "PT0S"}})) == ["-PT1M30S"]
            assert om.count("Hold", {"holdFor": {"gte": "P1D"}}) == 2
            (neg,) = om.find_many("Hold", {"holdFor": {"eq": "-PT90S"}})
            assert neg["holdFor"] == dt.timedelta(seconds=-90)
