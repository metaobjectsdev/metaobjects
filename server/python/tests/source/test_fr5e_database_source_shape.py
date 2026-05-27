"""FR5e — cross-port envelope shape lock for ``format: "database"``.

The schema is reserved by ADR-0009 and instantiable in every port today;
a real database-source loader is future work. This test pins the shape so
a future loader (FR5e implementation) has a guaranteed-correct target.
"""
from __future__ import annotations

import pytest

from metaobjects.source import DatabaseSource, DbLocation


def test_format_is_database():
    src = DatabaseSource(db_location=DbLocation(table="metaobjects_field_attr",
                                                id="fld_abc123/currency"))
    assert src.format == "database"


def test_db_location_carries_table_and_id():
    loc = DbLocation(table="metaobjects_object", id="obj_42")
    assert loc.table == "metaobjects_object"
    assert loc.id == "obj_42"


def test_json_path_is_optional():
    no_path = DatabaseSource(db_location=DbLocation(table="t", id="id"))
    assert no_path.json_path is None

    with_path = DatabaseSource(
        db_location=DbLocation(table="metaobjects_field_attr", id="fld_abc123/currency"),
        json_path="$.metadata.root.children[0].field.currency.@currency",
    )
    assert with_path.json_path == "$.metadata.root.children[0].field.currency.@currency"


def test_composite_key_encoded_in_id_string():
    """FR5e design lock: composite primary keys are encoded as a single
    delimited string in the id, e.g. ``"row_id/attr_name"``. This keeps the
    envelope schema dialect-neutral and avoids a deeper DbLocation shape.
    """
    loc = DbLocation(table="metaobjects_field_attr", id="fld_abc123/currency")
    assert loc.id == "fld_abc123/currency"


def test_frozen_dataclass_is_immutable():
    src = DatabaseSource(db_location=DbLocation(table="t", id="id"))
    with pytest.raises(Exception):  # FrozenInstanceError
        src.json_path = "/nope"  # type: ignore[misc]
