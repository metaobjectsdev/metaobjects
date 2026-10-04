"""FR-044 Plan 2 — the report READ MODEL's carry rules (Table B's type-source column).

A derived field is a new, detached ``field.*`` node. It takes its ``@required`` from the
derived shape and, when Table B gives it a type source, exactly these from that field:
``@currency``, ``@values``, ``@intValueMap``, ``@maxLength``, ``@precision``, ``@scale``,
``@localTime``, ``@objectRef``, ``@storage`` (read RESOLVING), its OWN ``@dbColumnType``
(never an inherited one), and array-ness. Nothing else: no ``@column``, no ``@default``.

The canonical corpus exercises few of these, so they are pinned here with inline models.
"""
from __future__ import annotations

import json

from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.meta.core.field.field_constants import (
    FIELD_ATTR_COLUMN,
    FIELD_ATTR_CURRENCY,
    FIELD_ATTR_DEFAULT,
    FIELD_ATTR_MAX_LENGTH,
    FIELD_ATTR_PRECISION,
    FIELD_ATTR_REQUIRED,
    FIELD_ATTR_SCALE,
    FIELD_ATTR_VALUES,
)
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.reporting.report_read_model import report_read_model
from metaobjects.meta.persistence.db.db_constants import (
    FIELD_ATTR_DB_COLUMN_TYPE,
    FIELD_ATTR_LOCAL_TIME,
)
from metaobjects.shared.base_types import TYPE_OBJECT

_MODEL = {
    "metadata.root": {
        "package": "shop",
        "children": [
            {
                "object.entity": {
                    "name": "Base",
                    "abstract": True,
                    "children": [
                        # Inherited by Sale.code below: @maxLength must be carried, the
                        # physical @dbColumnType must not.
                        {"field.string": {"name": "code", "@maxLength": 12, "@dbColumnType": "uuid"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Sale",
                    "children": [
                        {"source.rdb": {"@table": "sales"}},
                        {"field.long": {"name": "id"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"]}},
                        {"field.string": {"name": "code", "extends": "shop::Base.code"}},
                        {"field.string": {"name": "ref", "@dbColumnType": "uuid", "@column": "ref_col",
                                          "@required": True, "@default": "x"}},
                        {"field.string": {"name": "tags", "isArray": True}},
                        {"field.enum": {"name": "status", "@values": ["OPEN", "PAID"]}},
                        {"field.currency": {"name": "amountCents", "@currency": "EUR", "@required": True}},
                        {"field.decimal": {"name": "weight", "@precision": 10, "@scale": 2}},
                        {"field.timestamp": {"name": "bookedAt", "@localTime": True}},
                        {"dimension.attribute": {"name": "code", "@of": "Sale.code"}},
                        {"dimension.attribute": {"name": "ref", "@of": "Sale.ref"}},
                        {"dimension.attribute": {"name": "tags", "@of": "Sale.tags"}},
                        {"dimension.attribute": {"name": "status", "@of": "Sale.status"}},
                        {"dimension.time": {"name": "bookedAt", "@of": "Sale.bookedAt", "@grains": ["hour", "day"]}},
                        {"measure.aggregate": {"name": "sales", "@agg": "count", "@of": "Sale.id"}},
                        {"measure.aggregate": {"name": "revenue", "@agg": "sum", "@of": "Sale.amountCents"}},
                        {"measure.aggregate": {"name": "minAmount", "@agg": "min", "@of": "Sale.amountCents"}},
                        {"measure.aggregate": {"name": "totalWeight", "@agg": "sum", "@of": "Sale.weight"}},
                        {"measure.aggregate": {"name": "maxWeight", "@agg": "max", "@of": "Sale.weight"}},
                    ],
                }
            },
            {
                "object.report": {
                    "name": "R",
                    "@from": "Sale",
                    "@dimensions": ["code", "ref", "tags", "status", "bookedAt:hour", "bookedAt:day"],
                    "@measures": ["sales", "revenue", "minAmount", "totalWeight", "maxWeight"],
                    "children": [{"source.rdb": {"@kind": "view", "@view": "v_r"}}],
                }
            },
        ],
    }
}


def _fields() -> dict[str, MetaField]:
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(_MODEL), "meta.shop.json")])
    assert result.errors == [], [e.message for e in result.errors]
    report = next(c for c in result.root.children() if c.type == TYPE_OBJECT and c.name == "R")
    return {f.name: f for f in report_read_model(report, result.root).fields()}


def test_fields_are_one_per_table_b_row_in_order_with_the_derived_subtype() -> None:
    assert [(f.name, f.sub_type) for f in _fields().values()] == [
        ("code", "string"), ("ref", "string"), ("tags", "string"), ("status", "enum"),
        ("bookedAtHour", "timestamp"), ("bookedAtDay", "date"),
        ("sales", "long"), ("revenue", "currency"), ("minAmount", "currency"),
        ("totalWeight", "decimal"), ("maxWeight", "decimal"),
    ]


def test_currency_is_carried_by_a_sum_and_by_a_min() -> None:
    fields = _fields()
    assert fields["revenue"].get_meta_attr(FIELD_ATTR_CURRENCY) == "EUR"
    assert fields["minAmount"].get_meta_attr(FIELD_ATTR_CURRENCY) == "EUR"


def test_required_comes_from_the_derived_shape_never_from_the_type_source() -> None:
    fields = _fields()
    # A min of a required column is still nullable (no rows -> null); a count never is.
    assert fields["minAmount"].get_meta_attr(FIELD_ATTR_REQUIRED) is False
    assert fields["revenue"].get_meta_attr(FIELD_ATTR_REQUIRED) is False
    assert fields["sales"].get_meta_attr(FIELD_ATTR_REQUIRED) is True
    assert fields["ref"].get_meta_attr(FIELD_ATTR_REQUIRED) is True
    assert fields["code"].get_meta_attr(FIELD_ATTR_REQUIRED) is False


def test_values_and_max_length_are_carried_resolving() -> None:
    fields = _fields()
    assert fields["status"].get_meta_attr(FIELD_ATTR_VALUES) == ["OPEN", "PAID"]
    # Sale.code declares no @maxLength of its own: it inherits 12 from Base.code.
    assert fields["code"].get_meta_attr(FIELD_ATTR_MAX_LENGTH) == 12


def test_db_column_type_is_carried_only_when_the_of_field_declares_it_itself() -> None:
    fields = _fields()
    # ADR-0039: own — @dbColumnType is the one deliberately own-only attr; these
    # assertions are about exactly that, so they read it with the OWN accessor attr().
    assert fields["ref"].attr(FIELD_ATTR_DB_COLUMN_TYPE) == "uuid"
    assert fields["code"].attr(FIELD_ATTR_DB_COLUMN_TYPE) is None
    assert fields["code"].get_meta_attr(FIELD_ATTR_DB_COLUMN_TYPE) is None


def test_array_ness_is_carried() -> None:
    fields = _fields()
    assert fields["tags"].resolved_is_array() is True
    assert fields["code"].resolved_is_array() is False


def test_precision_scale_and_local_time_follow_the_type_source() -> None:
    fields = _fields()
    # max keeps the @of field as its type source; a sum of a decimal has none.
    assert fields["maxWeight"].get_meta_attr(FIELD_ATTR_PRECISION) == 10
    assert fields["maxWeight"].get_meta_attr(FIELD_ATTR_SCALE) == 2
    assert fields["totalWeight"].get_meta_attr(FIELD_ATTR_PRECISION) is None
    assert fields["totalWeight"].get_meta_attr(FIELD_ATTR_SCALE) is None
    # An hour bucket is the instant itself and keeps @localTime; a day bucket is a bare date.
    assert fields["bookedAtHour"].get_meta_attr(FIELD_ATTR_LOCAL_TIME) is True
    assert fields["bookedAtDay"].get_meta_attr(FIELD_ATTR_LOCAL_TIME) is None


def test_nothing_else_is_carried() -> None:
    ref = _fields()["ref"]
    # The physical column is the naming strategy applied to the DERIVED name, so the
    # @of field's @column is never inherited; nor is its @default.
    assert ref.get_meta_attr(FIELD_ATTR_COLUMN) is None
    assert ref.get_meta_attr(FIELD_ATTR_DEFAULT) is None
    assert sorted(ref.attrs()) == sorted([FIELD_ATTR_REQUIRED, FIELD_ATTR_DB_COLUMN_TYPE])
