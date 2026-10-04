"""FR-044 — the Python reporting vocabulary: node classes, report accessors, the
relative-date filter value, and spot checks of the ``validate_reporting`` message
text (the TypeScript reference ``reporting-validation.ts`` is normative; the shared
conformance fixtures gate the codes and sources, these tests pin the wording).
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from metaobjects.errors import ErrorCode
from metaobjects.loader.meta_data_loader import LoadResult, MetaDataLoader
from metaobjects.meta.core.attr.meta_attr import FilterAttr
from metaobjects.meta.core.reporting.meta_dimension import MetaDimension
from metaobjects.meta.core.reporting.meta_measure import MetaMeasure
from metaobjects.meta.core.reporting.meta_segment import MetaSegment
from metaobjects.meta.core.reporting.report_accessors import (
    ReportDimensionItem,
    report_derived_field_name,
    report_dimension_items,
    report_from,
    report_measure_names,
)
from metaobjects.meta.core.reporting.reporting_constants import (
    FILTER_RELATIVE_NOW,
    ISO_DURATION_RE,
    MEASURE_AGGS,
    TIME_GRAINS,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.base_types import (
    TYPE_DIMENSION,
    TYPE_MEASURE,
    TYPE_OBJECT,
    TYPE_RELATIONSHIP,
    TYPE_SEGMENT,
)


def _fixture_doc(name: str) -> dict[str, Any]:
    root = Path(__file__).resolve()
    while not (root / "fixtures" / "conformance").is_dir():
        assert root != root.parent, "could not locate fixtures/conformance"
        root = root.parent
    doc: dict[str, Any] = json.loads(
        (root / "fixtures" / "conformance" / name / "input" / "meta.shop.json").read_text()
    )
    return doc


def _load(doc: dict[str, Any]) -> LoadResult:
    return MetaDataLoader.from_string(json.dumps(doc), strict=True)


def _object(root: MetaData, name: str) -> MetaData:
    return next(c for c in root.children() if c.type == TYPE_OBJECT and c.name == name)


def _child(obj: MetaData, type_: str, name: str) -> MetaData:
    return next(c for c in obj.children() if c.type == type_ and c.name == name)


def _body(doc: dict[str, Any], name: str) -> dict[str, Any]:
    for wrapper in doc["metadata.root"]["children"]:
        body: dict[str, Any] = next(iter(wrapper.values()))
        if body.get("name") == name:
            return body
    raise KeyError(name)


def _member_body(doc: dict[str, Any], entity: str, key: str, name: str) -> dict[str, Any]:
    # Keyed by (wrapper key, name): Purchase carries a dimension.attribute AND a
    # relationship.association both named 'program'.
    for wrapper in _body(doc, entity)["children"]:
        if key in wrapper and wrapper[key].get("name") == name:
            body: dict[str, Any] = wrapper[key]
            return body
    raise KeyError((entity, key, name))


@pytest.fixture(scope="module")
def vocab() -> MetaData:
    result = _load(_fixture_doc("reporting-vocabulary"))
    assert result.errors == []
    return result.root


# ---------------------------------------------------------------------------
# Node classes + resolving accessors
# ---------------------------------------------------------------------------


def test_dimension_accessors(vocab: MetaData) -> None:
    purchase = _object(vocab, "Purchase")
    program = _child(purchase, TYPE_DIMENSION, "program")
    assert isinstance(program, MetaDimension)
    assert not program.is_time()
    assert program.of() == "Purchase.programId"
    assert program.via() is None
    assert program.grains() == []

    title = _child(purchase, TYPE_DIMENSION, "programTitle")
    assert isinstance(title, MetaDimension)
    assert title.via() == "Purchase.program"

    purchased_at = _child(purchase, TYPE_DIMENSION, "purchasedAt")
    assert isinstance(purchased_at, MetaDimension)
    assert purchased_at.is_time()
    assert purchased_at.grains() == ["day", "week", "month", "quarter", "year"]


def test_same_named_dimension_and_relationship_coexist(vocab: MetaData) -> None:
    purchase = _object(vocab, "Purchase")
    named_program = [c for c in purchase.children() if c.name == "program"]
    assert sorted(c.type for c in named_program) == [TYPE_DIMENSION, TYPE_RELATIONSHIP]


def test_measure_accessors(vocab: MetaData) -> None:
    purchase = _object(vocab, "Purchase")
    revenue = _child(purchase, TYPE_MEASURE, "revenue")
    assert isinstance(revenue, MetaMeasure)
    assert not revenue.is_ratio()
    assert revenue.agg() == "sum"
    assert not revenue.distinct()
    # @of is isArray: the authored bare string coerces to a one-element list.
    assert revenue.get_meta_attr("of") == ["Purchase.amountCents"]
    assert revenue.of_columns() == ["Purchase.amountCents"]
    assert revenue.segment_name() == "active"
    assert revenue.filter() is None

    buyers = _child(purchase, TYPE_MEASURE, "buyers")
    assert isinstance(buyers, MetaMeasure)
    assert buyers.distinct()

    refunded = _child(purchase, TYPE_MEASURE, "refundedPurchases")
    assert isinstance(refunded, MetaMeasure)
    # The shorthand `{ refunded: true }` desugars to the canonical op object.
    assert refunded.filter() == {"refunded": {"eq": True}}

    event = _object(vocab, "WorkoutEvent")
    days = _child(event, TYPE_MEASURE, "daysEngaged")
    assert isinstance(days, MetaMeasure)
    assert days.of_columns() == [
        "WorkoutEvent.programId",
        "WorkoutEvent.weekNumber",
        "WorkoutEvent.dayNumber",
    ]
    ratio = _child(event, TYPE_MEASURE, "avgDaysPerStarter")
    assert isinstance(ratio, MetaMeasure)
    assert ratio.is_ratio()
    assert ratio.numerator() == "daysEngaged"
    assert ratio.denominator() == "starters"
    assert ratio.agg() is None


def test_segment_accessor(vocab: MetaData) -> None:
    active = _child(_object(vocab, "Purchase"), TYPE_SEGMENT, "active")
    assert isinstance(active, MetaSegment)
    assert active.filter() == {"status": {"eq": "active"}}


def test_inherited_members_resolve_through_extends() -> None:
    result = _load(_fixture_doc("reporting-inherited-members"))
    assert result.errors == []
    event = _object(result.root, "WorkoutEvent")
    occurred = _child(event, TYPE_DIMENSION, "occurredAt")
    assert isinstance(occurred, MetaDimension)
    assert occurred.parent is _object(result.root, "BaseEvent")
    assert occurred.grains() == ["day", "week"]
    events = _child(event, TYPE_MEASURE, "events")
    assert isinstance(events, MetaMeasure)
    assert events.of_columns() == ["BaseEvent.id"]


# ---------------------------------------------------------------------------
# object.report accessors
# ---------------------------------------------------------------------------


def test_report_accessors(vocab: MetaData) -> None:
    daily = _object(vocab, "DailyRevenue")
    assert report_from(daily) == "Purchase"
    assert report_dimension_items(daily) == [ReportDimensionItem("purchasedAt", "day")]
    assert report_measure_names(daily) == ["purchases", "revenue"]
    # A relative-date operand survives desugaring unchanged under an explicit op.
    assert daily.get_meta_attr("filter") == {"purchasedAt": {"gte": {"now": "-P90D"}}}

    totals = _object(vocab, "StoreTotals")
    assert report_dimension_items(totals) == []
    assert report_measure_names(totals) == ["purchases", "buyers", "revenue"]


def test_report_derived_field_name() -> None:
    assert report_derived_field_name(ReportDimensionItem("program")) == "program"
    assert report_derived_field_name(ReportDimensionItem("purchasedAt", "day")) == "purchasedAtDay"
    assert report_derived_field_name(ReportDimensionItem("purchasedAt", "quarter")) == "purchasedAtQuarter"
    assert report_derived_field_name(ReportDimensionItem("purchasedAt", "")) == "purchasedAt"


def test_closed_sets_keep_contract_order() -> None:
    assert TIME_GRAINS == ("hour", "day", "week", "month", "quarter", "year")
    assert MEASURE_AGGS == ("count", "sum", "avg", "min", "max")


# ---------------------------------------------------------------------------
# Relative-date values
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("duration", ["-P7D", "P1Y2M", "-PT12H", "+P1W", "P1Y2M3W4DT5H6M7S", "PT0S"])
def test_iso_duration_accepts(duration: str) -> None:
    assert ISO_DURATION_RE.match(duration) is not None


@pytest.mark.parametrize("duration", ["P", "-P", "PT", "-PT", "P7", "7D", "-P7D\n", "P1DT", "90 days", ""])
def test_iso_duration_refuses(duration: str) -> None:
    assert ISO_DURATION_RE.match(duration) is None


def test_filter_desugar_matches_reference() -> None:
    attr = FilterAttr("attr", "filter", "filter")
    assert FILTER_RELATIVE_NOW == "now"
    assert attr.desugar(
        {
            "a": {"now": "-P7D"},  # shorthand relative value -> value of an implicit eq
            "b": {"gte": {"now": "-P7D"}},  # explicit op: the operand stays opaque
            "c": {"now": "P1D", "gte": 1},  # a `now` key makes it a (malformed) value
            "d": {"foo": 1},  # any other object is an op map, kept as-is
            "e": None,
            "f": [1, 2],
            "g": 3,
            "and": [{"h": 1}, {"i": {"lt": 2}}, 7],
            "or": "not-an-array",
        }
    ) == {
        "a": {"eq": {"now": "-P7D"}},
        "b": {"gte": {"now": "-P7D"}},
        "c": {"eq": {"now": "P1D", "gte": 1}},
        "d": {"foo": 1},
        "e": {"isNull": True},
        "f": {"in": [1, 2]},
        "g": {"eq": 3},
        "and": [{"h": {"eq": 1}}, {"i": {"lt": 2}}, 7],
        "or": "not-an-array",
    }


# ---------------------------------------------------------------------------
# validate_reporting — wording spot checks (one broken rule, one error)
# ---------------------------------------------------------------------------


def _errors(doc: dict[str, Any]) -> list[tuple[ErrorCode, str]]:
    return [(e.code, e.message) for e in _load(doc).errors]


def test_shorthand_relative_value_is_refused_as_eq() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-vocabulary"))
    _body(doc, "DailyRevenue")["@filter"] = {"purchasedAt": {"now": "-P7D"}}
    assert _errors(doc) == [
        (
            ErrorCode.ERR_BAD_ATTR_FILTER,
            "report 'acme::shop::DailyRevenue': @filter on 'purchasedAt' puts a relative date under op 'eq'; "
            "relative dates are legal only under gt, gte, lt and lte.",
        )
    ]


def test_malformed_relative_value_is_refused() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-vocabulary"))
    _body(doc, "DailyRevenue")["@filter"] = {"purchasedAt": {"gte": {"now": "-P7D", "x": 1}}}
    assert _errors(doc) == [
        (
            ErrorCode.ERR_BAD_ATTR_FILTER,
            "report 'acme::shop::DailyRevenue': @filter on 'purchasedAt' has a malformed relative date "
            '{"now":"-P7D","x":1}; a relative date is exactly { now: "<ISO-8601 duration>" } with no other keys.',
        )
    ]


def test_bad_op_lists_allowed_ops_in_canonical_order() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-vocabulary"))
    _member_body(doc, "Purchase", "segment.filter", "active")["@filter"] = {"status": {"gt": "a"}}
    assert _errors(doc) == [
        (
            ErrorCode.ERR_BAD_ATTR_FILTER,
            "segment 'active' on entity 'acme::shop::Purchase': @filter on 'status' uses op 'gt', which is not "
            "allowed for field.string. Allowed ops: eq, ne, in, like, isNull.",
        )
    ]


def test_composed_segment_filter_is_validated_per_sub_clause() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-vocabulary"))
    _member_body(doc, "Purchase", "segment.filter", "active")["@filter"] = {
        "or": [{"status": "x"}, {"purchasedAt": {"gte": {"now": "-P30D"}}}]
    }
    assert _errors(doc) == []


def test_field_named_now_is_a_field_not_a_relative_date() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-vocabulary"))
    doc["metadata.root"]["children"].append(
        {
            "object.projection": {
                "name": "P",
                "@filter": {"now": {"eq": 1}},
                "children": [{"field.int": {"name": "now"}}],
            }
        }
    )
    assert _errors(doc) == []


def test_each_inheritor_reports_a_broken_inherited_member_once() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-inherited-members"))
    _body(doc, "WorkoutEvent")["children"].append({"field.string": {"name": "occurredAt"}})
    doc["metadata.root"]["children"].insert(
        2,
        {
            "object.entity": {
                "name": "LoginEvent",
                "extends": "BaseEvent",
                "children": [
                    {"source.rdb": {"@table": "login_events"}},
                    {"identity.primary": {"name": "id", "@fields": ["id"]}},
                    {"field.string": {"name": "occurredAt"}},
                ],
            }
        },
    )
    body = (
        ": a time dimension's @of must be a field.date or field.timestamp, but 'BaseEvent.occurredAt' "
        "is field.string."
    )
    head = "dimension 'occurredAt' on entity 'acme::shop::BaseEvent'"
    assert _errors(doc) == [
        (ErrorCode.ERR_INVALID_DIMENSION, f"{head} (inherited by 'acme::shop::WorkoutEvent'){body}"),
        (ErrorCode.ERR_INVALID_DIMENSION, f"{head} (inherited by 'acme::shop::LoginEvent'){body}"),
    ]


def test_broken_base_member_is_reported_once() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-inherited-members"))
    _member_body(doc, "BaseEvent", "measure.aggregate", "events")["@of"] = "BaseEvent.nope"
    assert _errors(doc) == [
        (
            ErrorCode.ERR_INVALID_MEASURE,
            "measure 'events' on entity 'acme::shop::BaseEvent': @of 'BaseEvent.nope' names no field 'nope' "
            "on 'acme::shop::BaseEvent'.",
        )
    ]


def test_writable_report_source_names_every_read_only_kind() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-vocabulary"))
    _body(doc, "StoreTotals")["children"] = [{"source.rdb": {"@table": "store_totals"}}]
    assert _errors(doc) == [
        (
            ErrorCode.ERR_INVALID_REPORT,
            "report 'acme::shop::StoreTotals': source.rdb is writable; a report is read-only, so its source must "
            "declare a read-only @kind (view, materializedView, storedProc or tableFunction).",
        )
    ]


def test_attribute_dimension_and_measure_with_one_name_collide() -> None:
    # An attribute dimension derives its bare name, so dimension `revenue` and
    # measure `revenue` would both become report field `revenue` (R6).
    doc = copy.deepcopy(_fixture_doc("reporting-vocabulary"))
    _body(doc, "Purchase")["children"].append(
        {"dimension.attribute": {"name": "revenue", "@of": "Purchase.status"}}
    )
    _body(doc, "StoreTotals")["@dimensions"] = ["revenue"]
    assert _errors(doc) == [
        (
            ErrorCode.ERR_INVALID_REPORT,
            "report 'acme::shop::StoreTotals': dimension item 'revenue' and measure 'revenue' both derive report "
            "field 'revenue'. Report field names must be unique; rename the measure or drop one item.",
        )
    ]


def test_two_unresolved_dimension_items_are_two_errors() -> None:
    doc = copy.deepcopy(_fixture_doc("reporting-vocabulary"))
    _body(doc, "DailyRevenue")["@dimensions"] = ["region", "channel"]
    assert _errors(doc) == [
        (
            ErrorCode.ERR_INVALID_REPORT,
            f"report 'acme::shop::DailyRevenue': @dimensions item '{item}' names no dimension of @from "
            "'acme::shop::Purchase'.",
        )
        for item in ("region", "channel")
    ]
