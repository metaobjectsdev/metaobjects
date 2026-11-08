"""A ``source.rdb @schema`` places the relation the runtime reads and writes, on a live Postgres.

``meta migrate`` creates a table declared with ``@schema: sales`` as ``"sales"."payers"``, so the
ObjectManager must address it there, not as a bare ``"payers"`` (which ``search_path`` resolves to
``public``, a different table or none). Two ``Payer`` tables in two schemas are two relations.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import closing
from typing import Any

import pg8000.dbapi as pg8000
import pytest

from metaobjects import load_string
from metaobjects.runtime import ObjectManager, PostgresDriver

from .postgres_container import PostgresContainer


def _payer(package: str, schema: str) -> dict[str, Any]:
    return {"metadata.root": {"package": package, "children": [{"object.entity": {"name": "Payer", "children": [
        {"source.rdb": {"@table": "payers", "@schema": schema}},
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "label"}},
        {"identity.primary": {"name": "pk", "@fields": ["id"]}},
    ]}}]}}


@pytest.fixture
def pg() -> Iterator[Any]:
    with PostgresContainer() as container:
        info = container.info()
        with closing(pg8000.connect(host=info.host, port=info.port, user=info.user,
                                    password=info.password, database=info.database)) as conn:
            cur = conn.cursor()
            for schema in ("sales", "billing"):
                cur.execute(f'CREATE SCHEMA "{schema}"')
                cur.execute(f'CREATE TABLE "{schema}"."payers" ("id" BIGINT PRIMARY KEY, "label" TEXT)')
            conn.commit()
            yield conn


def test_a_schema_qualified_entity_is_read_and_written_in_its_schema(pg: Any) -> None:
    for schema in ("sales", "billing"):
        result = load_string(json.dumps(_payer(schema, schema)))
        assert result.errors == [], result.errors
        om = ObjectManager(result.root, PostgresDriver(pg))
        om.create("Payer", {"id": 1, "label": schema})
        assert om.find_by_id("Payer", 1)["label"] == schema
        assert [r["label"] for r in om.find_many("Payer")] == [schema]
    cur = pg.cursor()
    cur.execute('SELECT label FROM "sales"."payers" UNION ALL SELECT label FROM "billing"."payers"')
    assert sorted(r[0] for r in cur.fetchall()) == ["billing", "sales"]
