"""field.duration on a live Postgres through the ObjectManager: the shared interval codec
vectors against each driver's native read path. Ordering, range filters and the canonical wire
form are gated by ``test_api_contract_duration.py`` (the ``api-contract-conformance/duration``
corpus), which replaced the bespoke ordering test that lived here."""
from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path
from typing import Any

import pg8000.dbapi as pg8000
import pytest

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


_VECTORS = json.loads(
    (Path(__file__).resolve().parents[4] / "fixtures" / "duration-wire" / "vectors.json").read_text()
)["codecs"]


def _pg8000(info: Any) -> Any:
    return pg8000.connect(host=info.host, port=info.port, user=info.user, password=info.password, database=info.database)


def _psycopg(info: Any) -> Any:
    psycopg = pytest.importorskip("psycopg")
    return psycopg.connect(
        host=info.host, port=info.port, user=info.user, password=info.password, dbname=info.database,
    )


def _psycopg2(info: Any) -> Any:
    psycopg2 = pytest.importorskip("psycopg2")
    return psycopg2.connect(
        host=info.host, port=info.port, user=info.user, password=info.password, dbname=info.database,
    )


@pytest.mark.parametrize("connect", [_pg8000, _psycopg, _psycopg2], ids=["pg8000", "psycopg", "psycopg2"])
def test_an_interval_reads_as_its_span_and_one_with_a_month_part_is_refused(connect: Any) -> None:
    """The shared ``postgres`` / ``postgresRefused`` vectors against the native read path: each
    interval is stored by Postgres itself and read back through the driver and the
    ObjectManager. Left to themselves pg8000 drops the sign of a negative time part
    (``-00:01:30`` is +90 s) and psycopg makes a month 30 days; neither reaches a duration."""
    root: Any = load_string(json.dumps(_META)).root
    root.naming = NamingRules(columns="literal")
    with PostgresContainer() as pg:
        with closing(connect(pg.info())) as conn:
            cur = conn.cursor()
            cur.execute('CREATE TABLE "holds" ("id" BIGINT PRIMARY KEY, "holdFor" INTERVAL)')
            conn.commit()
            driver = PostgresDriver(conn)
            om = ObjectManager(root, driver)
            dcur = driver._cursor()
            dcur.execute("SELECT ARRAY[CAST('-01:30:00' AS interval), CAST('-00:00:01.5' AS interval)]")
            assert [format_duration(d) for d in dcur.fetchone()[0]] == ["-PT1H30M", "-PT1.5S"]
            for i, v in enumerate(_VECTORS["postgres"]):
                cur.execute('INSERT INTO "holds" VALUES (%s, CAST(%s AS interval))', (i, v["in"]))
                conn.commit()
                assert format_duration(om.find_by_id("Hold", i)["holdFor"]) == v["out"], v["in"]
            refused = [t for t in _VECTORS["postgresRefused"] if any(u in t for u in ("year", "mon"))]
            assert refused, "the shared vectors have intervals with a year or month part"
            for i, text in enumerate(refused, start=1000):
                cur.execute('INSERT INTO "holds" VALUES (%s, CAST(%s AS interval))', (i, text))
                conn.commit()
                with pytest.raises(ValueError, match="year or month part"):
                    om.find_by_id("Hold", i)
