"""FR-044 — ``validate_reporting`` for a report's ``@spine`` (R8, R9) and a measure's
``@default`` (M7, M8): Table B of
docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md.

A Python port of the "@spine (R8, R9)" and "measure @default (M7, M8)" blocks of the
TypeScript reference suite
``server/typescript/packages/metadata/test/reporting-validation.test.ts``. Every expected
message is the TypeScript text verbatim: the ports share one message contract, and the
shared conformance fixtures gate only the codes and the sources.

The one exception is a fractional measure ``@default``. TypeScript refuses it in its
reporting pass because its generic attr.int check lets a fraction through; this port's
generic attr-type check already refuses it with ERR_BAD_ATTR_VALUE (its own text) on the
measure node, so no second, reporting-specific error is added. Those cases pin the code,
the node and that it is the only error.

Every broken model is the clean spec §4 model (Purchase / Program / WorkoutEvent and three
reports) with exactly one change, and every test asserts the FULL error-code list: one
broken rule produces exactly one error, never a cascade.
"""
from __future__ import annotations

import json
from typing import Any

from metaobjects.errors import MetaError
from metaobjects.loader.meta_data_loader import MetaDataLoader

Body = dict[str, Any]
Wrapper = dict[str, Body]
Model = dict[str, Any]

_PKG = "acme::shop"
_MEMBER_TYPES = ("dimension", "measure", "segment")


# ---------------------------------------------------------------------------
# Model builders (the TypeScript suite's, rule for rule)
# ---------------------------------------------------------------------------


def _field(sub_type: str, name: str, **extra: Any) -> Wrapper:
    return {f"field.{sub_type}": {"name": name, **extra}}


def _primary() -> Wrapper:
    return {"identity.primary": {"name": "id", "@fields": ["id"]}}


def _full_reporting_model() -> Model:
    return {
        "metadata.root": {
            "package": _PKG,
            "children": [
                {
                    "object.entity": {
                        "name": "Program",
                        "children": [
                            {"source.rdb": {"@table": "programs"}},
                            _field("long", "id"),
                            _field("string", "title"),
                            _primary(),
                            {
                                "relationship.association": {
                                    "name": "purchases",
                                    "@objectRef": "Purchase",
                                    "@cardinality": "many",
                                }
                            },
                        ],
                    }
                },
                {
                    "object.entity": {
                        "name": "Purchase",
                        "children": [
                            {"source.rdb": {"@table": "purchases"}},
                            _field("long", "id"),
                            _field("long", "programId"),
                            _field("string", "customerEmail"),
                            _field("currency", "amountCents"),
                            _field("string", "status"),
                            _field("boolean", "refunded"),
                            _field("timestamp", "purchasedAt"),
                            _field("date", "purchasedOn"),
                            _primary(),
                            {
                                "identity.reference": {
                                    "name": "programRef",
                                    "@references": "Program",
                                    "@fields": ["programId"],
                                }
                            },
                            {
                                "relationship.association": {
                                    "name": "program",
                                    "@objectRef": "Program",
                                    "@cardinality": "one",
                                }
                            },
                            {"dimension.attribute": {"name": "program", "@of": "Purchase.programId"}},
                            {
                                "dimension.attribute": {
                                    "name": "programTitle",
                                    "@of": "Program.title",
                                    "@via": "Purchase.program",
                                }
                            },
                            {
                                "dimension.time": {
                                    "name": "purchasedAt",
                                    "@of": "Purchase.purchasedAt",
                                    "@grains": ["day", "week", "month", "quarter", "year"],
                                }
                            },
                            {
                                "measure.aggregate": {
                                    "name": "purchases",
                                    "@agg": "count",
                                    "@of": "Purchase.id",
                                    "@segment": "active",
                                }
                            },
                            {
                                "measure.aggregate": {
                                    "name": "buyers",
                                    "@agg": "count",
                                    "@distinct": True,
                                    "@of": "Purchase.customerEmail",
                                    "@segment": "active",
                                }
                            },
                            {
                                "measure.aggregate": {
                                    "name": "revenue",
                                    "@agg": "sum",
                                    "@of": "Purchase.amountCents",
                                    "@segment": "active",
                                }
                            },
                            {"segment.filter": {"name": "active", "@filter": {"status": "active"}}},
                        ],
                    }
                },
                {
                    "object.entity": {
                        "name": "WorkoutEvent",
                        "children": [
                            {"source.rdb": {"@table": "workout_events"}},
                            _field("long", "id"),
                            _field("long", "programId"),
                            _field("string", "customerEmail"),
                            _field("int", "weekNumber"),
                            _field("int", "dayNumber"),
                            _field("string", "eventType"),
                            _field("timestamp", "occurredAt"),
                            _primary(),
                            {"dimension.attribute": {"name": "program", "@of": "WorkoutEvent.programId"}},
                            {
                                "measure.aggregate": {
                                    "name": "starters",
                                    "@agg": "count",
                                    "@distinct": True,
                                    "@of": "WorkoutEvent.customerEmail",
                                }
                            },
                            {
                                "measure.aggregate": {
                                    "name": "daysEngaged",
                                    "@agg": "count",
                                    "@distinct": True,
                                    "@of": [
                                        "WorkoutEvent.programId",
                                        "WorkoutEvent.customerEmail",
                                        "WorkoutEvent.weekNumber",
                                        "WorkoutEvent.dayNumber",
                                    ],
                                }
                            },
                            {
                                "measure.aggregate": {
                                    "name": "lastActivityAt",
                                    "@agg": "max",
                                    "@of": "WorkoutEvent.occurredAt",
                                }
                            },
                            {
                                "measure.ratio": {
                                    "name": "avgDaysPerStarter",
                                    "@numerator": "daysEngaged",
                                    "@denominator": "starters",
                                }
                            },
                            {
                                "segment.filter": {
                                    "name": "completions",
                                    "@filter": {"eventType": "exercise_complete"},
                                }
                            },
                        ],
                    }
                },
                {
                    "object.report": {
                        "name": "ProgramEngagement",
                        "@from": "WorkoutEvent",
                        "@dimensions": ["program"],
                        "@measures": ["starters", "daysEngaged", "avgDaysPerStarter", "lastActivityAt"],
                        "@segment": "completions",
                    }
                },
                {
                    "object.report": {
                        "name": "DailyRevenue",
                        "@from": "Purchase",
                        "@dimensions": ["purchasedAt:day"],
                        "@measures": ["purchases", "revenue"],
                        "@filter": {"purchasedAt": {"gte": {"now": "-P90D"}}},
                    }
                },
                {
                    "object.report": {
                        "name": "StoreTotals",
                        "@from": "Purchase",
                        "@measures": ["purchases", "buyers", "revenue"],
                    }
                },
            ],
        }
    }


def _inherited_model() -> Model:
    return {
        "metadata.root": {
            "package": _PKG,
            "children": [
                {
                    "object.entity": {
                        "name": "BaseEvent",
                        "abstract": True,
                        "children": [
                            _field("long", "id"),
                            _field("timestamp", "occurredAt"),
                            {
                                "dimension.time": {
                                    "name": "occurredAt",
                                    "@of": "BaseEvent.occurredAt",
                                    "@grains": ["day", "week"],
                                }
                            },
                            {"measure.aggregate": {"name": "events", "@agg": "count", "@of": "BaseEvent.id"}},
                        ],
                    }
                },
                {
                    "object.entity": {
                        "name": "WorkoutEvent",
                        "extends": "BaseEvent",
                        "children": [
                            {"source.rdb": {"@table": "workout_events"}},
                            _field("string", "eventType"),
                            _primary(),
                        ],
                    }
                },
                {
                    "object.report": {
                        "name": "DailyEvents",
                        "@from": "WorkoutEvent",
                        "@dimensions": ["occurredAt:day"],
                        "@measures": ["events"],
                    }
                },
            ],
        }
    }


def _object_body(m: Model, name: str) -> Body:
    for w in m["metadata.root"]["children"]:
        body: Body = next(iter(w.values()))
        if body.get("name") == name:
            return body
    raise KeyError(f"no object {name}")


def _children_of(m: Model, obj_name: str) -> list[Wrapper]:
    body = _object_body(m, obj_name)
    kids: list[Wrapper] = body.setdefault("children", [])
    return kids


def _wrapper_type(w: Wrapper) -> str:
    return next(iter(w)).split(".")[0]


def _set_child(m: Model, obj_name: str, child_name: str, w: Wrapper) -> None:
    """Replace the child of ``obj_name`` with the same base type as ``w`` and named
    ``child_name``, or append ``w``."""
    kids = _children_of(m, obj_name)
    for i, k in enumerate(kids):
        if _wrapper_type(k) == _wrapper_type(w) and next(iter(k.values())).get("name") == child_name:
            kids[i] = w
            return
    kids.append(w)


def _patch(body: Body, attrs: Body) -> None:
    """Shallow-merge ``attrs``; a ``None`` value deletes the key."""
    for k, v in attrs.items():
        if v is None:
            body.pop(k, None)
        else:
            body[k] = v


def _patch_object(m: Model, obj_name: str, attrs: Body) -> None:
    _patch(_object_body(m, obj_name), attrs)


def _patch_member(m: Model, obj_name: str, child_name: str, attrs: Body) -> None:
    for k in _children_of(m, obj_name):
        if _wrapper_type(k) in _MEMBER_TYPES and next(iter(k.values())).get("name") == child_name:
            _patch(next(iter(k.values())), attrs)
            return
    raise KeyError(f"no member {obj_name}.{child_name}")


def _edit(fn: Any) -> Model:
    m = _full_reporting_model()
    fn(m)
    return m


def _errors(doc: Model) -> list[MetaError]:
    return MetaDataLoader.from_string(json.dumps(doc), strict=True).errors


def _codes(doc: Model) -> list[str]:
    return [e.code.value for e in _errors(doc)]


def _single(doc: Model, code: str) -> str:
    errors = _errors(doc)
    assert [e.code.value for e in errors] == [code], [e.message for e in errors]
    return errors[0].message


def _json_path(error: MetaError) -> str:
    path = getattr(error.envelope, "json_path", None)
    assert isinstance(path, str), error
    return path


# ---------------------------------------------------------------------------
# R8 / R9 — a report's @spine
# ---------------------------------------------------------------------------


def _add_spine_report(m: Model, attrs: Body | None = None) -> None:
    """Append report ``ProgramPurchases`` over Purchase with ``@spine: Purchase.program``;
    ``attrs`` override (``None`` deletes)."""
    m["metadata.root"]["children"].append(
        {
            "object.report": {
                "name": "ProgramPurchases",
                "@from": "Purchase",
                "@spine": "Purchase.program",
                "@dimensions": ["programTitle"],
                "@measures": ["purchases", "revenue"],
            }
        }
    )
    _patch_object(m, "ProgramPurchases", attrs or {})


def _add_coach_chain(m: Model) -> None:
    """Program -> Coach -> Agency, both to-one, plus Purchase dimensions at the end of each hop."""
    _children_of(m, "Program").extend(
        [
            _field("long", "coachId"),
            {"identity.reference": {"name": "coachRef", "@references": "Coach", "@fields": ["coachId"]}},
            {"relationship.association": {"name": "coach", "@objectRef": "Coach", "@cardinality": "one"}},
        ]
    )
    m["metadata.root"]["children"].extend(
        [
            {
                "object.entity": {
                    "name": "Coach",
                    "children": [
                        {"source.rdb": {"@table": "coaches"}},
                        _field("long", "id"),
                        _field("string", "name"),
                        _field("long", "agencyId"),
                        _primary(),
                        {"identity.reference": {"name": "agencyRef", "@references": "Agency", "@fields": ["agencyId"]}},
                        {"relationship.association": {"name": "agency", "@objectRef": "Agency", "@cardinality": "one"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Agency",
                    "children": [
                        {"source.rdb": {"@table": "agencies"}},
                        _field("long", "id"),
                        _field("string", "name"),
                        _primary(),
                    ],
                }
            },
        ]
    )
    _children_of(m, "Purchase").extend(
        [
            {"dimension.attribute": {"name": "coachName", "@of": "Coach.name", "@via": "Purchase.program.coach"}},
            {
                "dimension.attribute": {
                    "name": "agencyName",
                    "@of": "Agency.name",
                    "@via": "Purchase.program.coach.agency",
                }
            },
        ]
    )


def _program_title_by_ref() -> Wrapper:
    """A dimension of Purchase reaching Program.title through the identity.reference, not the relationship."""
    return {
        "dimension.attribute": {"name": "programTitleByRef", "@of": "Program.title", "@via": "Purchase.programRef"}
    }


def test_a_spine_report_whose_dimensions_are_all_reached_through_the_spine_loads_clean() -> None:
    assert _codes(_edit(_add_spine_report)) == []


def test_r8_a_to_many_spine_hop_is_refused_naming_the_report_and_the_hops_entity() -> None:
    def fn(x: Model) -> None:
        _set_child(
            x, "Program", "programs", {"measure.aggregate": {"name": "programs", "@agg": "count", "@of": "Program.id"}}
        )
        x["metadata.root"]["children"].append(
            {
                "object.report": {
                    "name": "ProgramReach",
                    "@from": "Program",
                    "@spine": "Program.purchases",
                    "@measures": ["programs"],
                }
            }
        )

    assert _single(_edit(fn), "ERR_INVALID_REPORT") == (
        "report 'acme::shop::ProgramReach': @spine 'Program.purchases' crosses relationship 'purchases' on "
        "'acme::shop::Program', which is not to-one. A @spine follows only @cardinality: one relationships "
        "and identity.reference hops, so each fact row joins at most one row of the spine entity and is never "
        "counted twice."
    )


def test_r8_a_spine_whose_owner_is_another_entity_is_refused() -> None:
    m = _edit(lambda x: _add_spine_report(x, {"@spine": "Program.purchases"}))
    assert _single(m, "ERR_INVALID_REPORT") == (
        "report 'acme::shop::ProgramPurchases': @spine 'Program.purchases' must start at @from 'acme::shop::Purchase'."
    )


def test_r8_a_spine_hop_that_names_nothing_is_refused_naming_from_as_the_hops_entity() -> None:
    m = _edit(lambda x: _add_spine_report(x, {"@spine": "Purchase.nope"}))
    assert _single(m, "ERR_INVALID_REPORT") == (
        "report 'acme::shop::ProgramPurchases': @spine 'Purchase.nope' names 'nope', which is not a relationship "
        "or identity.reference of 'acme::shop::Purchase'."
    )


def test_r8_a_spine_with_no_hop_is_refused() -> None:
    m = _edit(lambda x: _add_spine_report(x, {"@spine": "Purchase"}))
    assert _single(m, "ERR_INVALID_REPORT") == (
        "report 'acme::shop::ProgramPurchases': @spine 'Purchase' must be Owner.hop[.hop...], starting at "
        "@from 'acme::shop::Purchase'."
    )


def test_d2s_to_many_wording_is_unchanged_by_the_walks_wording_argument() -> None:
    m = _edit(
        lambda x: _set_child(
            x,
            "Program",
            "buyerEmail",
            {
                "dimension.attribute": {
                    "name": "buyerEmail",
                    "@of": "Purchase.customerEmail",
                    "@via": "Program.purchases",
                }
            },
        )
    )
    assert _single(m, "ERR_INVALID_DIMENSION") == (
        "dimension 'buyerEmail' on entity 'acme::shop::Program': @via 'Program.purchases' crosses relationship "
        "'purchases' on 'acme::shop::Program', which is not to-one. A dimension follows only @cardinality: one "
        "relationships and identity.reference hops, so grouping can never multiply the measured rows."
    )


def test_d2s_own_wording_is_unchanged_by_the_walks_wording_argument() -> None:
    def d2(via: str) -> str:
        return _single(
            _edit(lambda x: _patch_member(x, "Purchase", "programTitle", {"@via": via})), "ERR_INVALID_DIMENSION"
        )

    head = "dimension 'programTitle' on entity 'acme::shop::Purchase': "
    assert d2("Purchase") == f"{head}@via 'Purchase' must be Owner.hop[.hop...], starting at the owning entity."
    assert d2("WorkoutEvent.program") == (
        f"{head}@via 'WorkoutEvent.program' must start at the owning entity 'acme::shop::Purchase'."
    )
    assert d2("Purchase.nope") == (
        f"{head}@via 'Purchase.nope' names 'nope', which is not a relationship or identity.reference of "
        "'acme::shop::Purchase'."
    )


def test_r8_the_error_source_is_the_report_node() -> None:
    errors = _errors(_edit(lambda x: _add_spine_report(x, {"@spine": "Purchase.nope"})))
    assert _json_path(errors[0]).endswith("['object.report']")


def test_r8_failing_skips_r9_a_broken_spine_with_an_off_spine_dimension_is_one_error() -> None:
    m = _edit(lambda x: _add_spine_report(x, {"@spine": "Purchase.nope", "@dimensions": ["purchasedAt:day"]}))
    assert "@spine 'Purchase.nope' names 'nope'" in _single(m, "ERR_INVALID_REPORT")


def test_r8_an_inherited_spine_owner_written_as_the_abstract_base_loads_clean() -> None:
    m = _inherited_model()
    m["metadata.root"]["children"].append(
        {
            "object.entity": {
                "name": "Program",
                "children": [
                    {"source.rdb": {"@table": "programs"}},
                    _field("long", "id"),
                    _field("string", "title"),
                    _primary(),
                ],
            }
        }
    )
    _children_of(m, "BaseEvent").extend(
        [
            _field("long", "programId"),
            {"identity.reference": {"name": "programRef", "@references": "Program", "@fields": ["programId"]}},
            {"relationship.association": {"name": "program", "@objectRef": "Program", "@cardinality": "one"}},
            {"dimension.attribute": {"name": "programTitle", "@of": "Program.title", "@via": "BaseEvent.program"}},
        ]
    )
    m["metadata.root"]["children"].append(
        {
            "object.report": {
                "name": "ProgramEvents",
                "@from": "WorkoutEvent",
                "@spine": "BaseEvent.program",
                "@dimensions": ["programTitle"],
                "@measures": ["events"],
            }
        }
    )
    assert _codes(m) == []


def test_r9_a_spine_report_with_no_dimensions_is_refused() -> None:
    m = _edit(lambda x: _add_spine_report(x, {"@dimensions": None}))
    assert _single(m, "ERR_INVALID_REPORT") == (
        "report 'acme::shop::ProgramPurchases': @spine 'Purchase.program' needs at least one dimension. The "
        "report's rows are the dimension tuples of 'acme::shop::Program'; with no dimension it would be one "
        "totals row."
    )


def test_r9_a_dimension_with_no_via_read_from_the_fact_row_is_refused() -> None:
    m = _edit(lambda x: _add_spine_report(x, {"@dimensions": ["programTitle", "program"]}))
    assert _single(m, "ERR_INVALID_REPORT") == (
        "report 'acme::shop::ProgramPurchases': dimension 'program' is read from @from 'acme::shop::Purchase', so "
        "it has no value in a row that has no facts. With @spine 'Purchase.program' every dimension must be "
        "reached through it: declare the dimension over a field of 'acme::shop::Program' (or an entity to-one "
        "from it) with an @via that begins 'Purchase.program'."
    )


def test_r9_a_time_dimension_over_a_fact_column_is_refused() -> None:
    m = _edit(lambda x: _add_spine_report(x, {"@dimensions": ["programTitle", "purchasedAt:day"]}))
    assert "report 'acme::shop::ProgramPurchases': dimension 'purchasedAt' is read from @from" in _single(
        m, "ERR_INVALID_REPORT"
    )


def test_r9_each_offending_dimension_is_reported_once_even_when_listed_at_two_grains() -> None:
    m = _edit(
        lambda x: _add_spine_report(
            x, {"@dimensions": ["program", "purchasedAt:day", "purchasedAt:week", "programTitle"]}
        )
    )
    errors = _errors(m)
    assert [e.code.value for e in errors] == ["ERR_INVALID_REPORT", "ERR_INVALID_REPORT"]
    assert "dimension 'program' is read from @from" in errors[0].message
    assert "dimension 'purchasedAt' is read from @from" in errors[1].message


def test_r9_a_dimension_through_a_second_reference_to_the_same_entity_is_refused() -> None:
    def fn(x: Model) -> None:
        _children_of(x, "Purchase").extend(
            [
                _field("long", "giftProgramId"),
                {
                    "identity.reference": {
                        "name": "giftProgramRef",
                        "@references": "Program",
                        "@fields": ["giftProgramId"],
                    }
                },
                _program_title_by_ref(),
                {
                    "dimension.attribute": {
                        "name": "giftProgramTitle",
                        "@of": "Program.title",
                        "@via": "Purchase.giftProgramRef",
                    }
                },
            ]
        )
        _add_spine_report(
            x, {"@spine": "Purchase.programRef", "@dimensions": ["programTitleByRef", "giftProgramTitle"]}
        )

    assert _single(_edit(fn), "ERR_INVALID_REPORT") == (
        "report 'acme::shop::ProgramPurchases': dimension 'giftProgramTitle' is reached by @via "
        "'Purchase.giftProgramRef', which does not begin with the hops of @spine 'Purchase.programRef'. Hop names "
        "are compared as written: if both name the same join, write the same hops; otherwise the dimension is "
        "not reached through the spine."
    )


def test_r9_a_dimension_whose_own_via_fails_d2_is_reported_once_by_d2_not_also_by_r9() -> None:
    def fn(x: Model) -> None:
        _patch_member(x, "Purchase", "programTitle", {"@via": "Purchase.programm"})
        _add_spine_report(x)

    assert "@via 'Purchase.programm' names 'programm'" in _single(_edit(fn), "ERR_INVALID_DIMENSION")


def test_r9_the_same_join_named_by_the_relationship_in_spine_and_the_reference_in_via_is_refused() -> None:
    def fn(x: Model) -> None:
        _children_of(x, "Purchase").append(_program_title_by_ref())
        _add_spine_report(x, {"@spine": "Purchase.program", "@dimensions": ["programTitleByRef"]})

    msg = _single(_edit(fn), "ERR_INVALID_REPORT")
    assert "dimension 'programTitleByRef' is reached by @via 'Purchase.programRef'" in msg
    assert "@spine 'Purchase.program'" in msg


def test_r9_the_owner_segment_is_not_compared() -> None:
    """An FQN spine owner, a bare dimension @via."""
    assert _codes(_edit(lambda x: _add_spine_report(x, {"@spine": "acme::shop::Purchase.program"}))) == []


def test_r9_a_time_dimension_over_a_column_of_the_spine_entity_is_legal() -> None:
    def fn(x: Model) -> None:
        _children_of(x, "Program").append(_field("timestamp", "publishedAt"))
        _children_of(x, "Purchase").append(
            {
                "dimension.time": {
                    "name": "programPublishedAt",
                    "@of": "Program.publishedAt",
                    "@via": "Purchase.program",
                    "@grains": ["month"],
                }
            }
        )
        _add_spine_report(x, {"@dimensions": ["programTitle", "programPublishedAt:month"]})

    assert _codes(_edit(fn)) == []


def test_r9_a_two_hop_spine_with_a_dimension_at_it_and_one_beyond_it_is_legal() -> None:
    def fn(x: Model) -> None:
        _add_coach_chain(x)
        _add_spine_report(x, {"@spine": "Purchase.program.coach", "@dimensions": ["coachName", "agencyName"]})

    assert _codes(_edit(fn)) == []


def test_r9_a_dimension_that_stops_short_of_a_two_hop_spine_is_refused() -> None:
    def fn(x: Model) -> None:
        _add_coach_chain(x)
        _add_spine_report(x, {"@spine": "Purchase.program.coach", "@dimensions": ["coachName", "programTitle"]})

    assert "dimension 'programTitle' is reached by @via 'Purchase.program'" in _single(_edit(fn), "ERR_INVALID_REPORT")


# ---------------------------------------------------------------------------
# M7 / M8 — where a measure's @default can apply
# ---------------------------------------------------------------------------


def test_m7_default_on_a_count_is_refused_on_the_measure_node() -> None:
    errors = _errors(_edit(lambda x: _patch_member(x, "Purchase", "purchases", {"@default": 0})))
    assert [e.code.value for e in errors] == ["ERR_INVALID_MEASURE"]
    assert errors[0].message == (
        "measure 'purchases' on entity 'acme::shop::Purchase': @default cannot apply to @agg: count. A count is "
        "never null (it is 0 when nothing matches); remove @default."
    )
    assert "['measure.aggregate']" in _json_path(errors[0])


def test_m7_default_on_a_distinct_count_of_a_tuple_is_refused() -> None:
    msg = _single(
        _edit(lambda x: _patch_member(x, "WorkoutEvent", "daysEngaged", {"@default": 0})), "ERR_INVALID_MEASURE"
    )
    assert "measure 'daysEngaged'" in msg
    assert "@default cannot apply to @agg: count" in msg


def test_m8_default_on_a_max_of_a_timestamp_is_refused() -> None:
    msg = _single(
        _edit(lambda x: _patch_member(x, "WorkoutEvent", "lastActivityAt", {"@default": 0})), "ERR_INVALID_MEASURE"
    )
    assert msg == (
        "measure 'lastActivityAt' on entity 'acme::shop::WorkoutEvent': @default is a number, but "
        "'WorkoutEvent.occurredAt', the @of of @agg 'max', is a field.timestamp. A default is supported on "
        "numeric measures only."
    )


def test_a_non_integer_default_on_a_count_reports_m7_and_the_attribute_type_error() -> None:
    errors = _errors(_edit(lambda x: _patch_member(x, "Purchase", "purchases", {"@default": "zero"})))
    assert sorted(e.code.value for e in errors) == ["ERR_BAD_ATTR_VALUE", "ERR_INVALID_MEASURE"]
    m7 = next(e for e in errors if e.code.value == "ERR_INVALID_MEASURE")
    assert "measure 'purchases' on entity 'acme::shop::Purchase': @default cannot apply to @agg: count." in m7.message


def test_a_boolean_default_on_a_count_reports_m7_and_the_attribute_type_error() -> None:
    """``bool`` is a subclass of ``int`` in Python, so ``true`` must not pass for the
    integer 1: it is the attribute type error, not a fraction, so M7 still reads the
    attribute as present (the "zero" case above, for this port's bool trap)."""
    errors = _errors(_edit(lambda x: _patch_member(x, "Purchase", "purchases", {"@default": True})))
    assert sorted(e.code.value for e in errors) == ["ERR_BAD_ATTR_VALUE", "ERR_INVALID_MEASURE"]


def _fractional(entity: str, measure: str, value: float) -> MetaError:
    """The ONE error a fractional @default yields: this port's generic attr.int check."""
    errors = _errors(_edit(lambda x: _patch_member(x, entity, measure, {"@default": value})))
    assert [e.code.value for e in errors] == ["ERR_BAD_ATTR_VALUE"], [e.message for e in errors]
    assert "'@default'" in errors[0].message
    return errors[0]


def test_a_fractional_default_on_a_sum_is_err_bad_attr_value_on_the_measure_node_once() -> None:
    assert "['measure.aggregate']" in _json_path(_fractional("Purchase", "revenue", 0.5))


def test_a_fractional_default_on_a_ratio_is_err_bad_attr_value_on_the_ratio() -> None:
    assert "['measure.ratio']" in _json_path(_fractional("WorkoutEvent", "avgDaysPerStarter", 0.5))


def test_the_integer_check_runs_first_a_fractional_default_on_a_count_skips_m7() -> None:
    _fractional("Purchase", "purchases", 0.5)


def test_the_integer_check_runs_first_a_fractional_default_on_a_max_of_a_timestamp_skips_m8() -> None:
    _fractional("WorkoutEvent", "lastActivityAt", -1.5)


def test_a_fractional_default_on_a_sum_declared_on_an_abstract_base_is_reported_once() -> None:
    m = _inherited_model()
    _children_of(m, "BaseEvent")[3] = {
        "measure.aggregate": {"name": "events", "@agg": "sum", "@of": "BaseEvent.id", "@default": 0.5}
    }
    assert "'@default'" in _single(m, "ERR_BAD_ATTR_VALUE")


def test_default_on_a_sum_an_avg_a_min_of_an_int_and_a_ratio_is_fine() -> None:
    def fn(x: Model) -> None:
        _patch_member(x, "Purchase", "revenue", {"@default": 0})
        _set_child(
            x,
            "Purchase",
            "avgRevenue",
            {"measure.aggregate": {"name": "avgRevenue", "@agg": "avg", "@of": "Purchase.amountCents", "@default": 0}},
        )
        _set_child(
            x,
            "WorkoutEvent",
            "firstDay",
            {"measure.aggregate": {"name": "firstDay", "@agg": "min", "@of": "WorkoutEvent.dayNumber", "@default": 1}},
        )
        _patch_member(x, "WorkoutEvent", "avgDaysPerStarter", {"@default": 0})

    assert _codes(_edit(fn)) == []


def test_a_measure_that_breaks_m4_and_declares_default_reports_m4_only() -> None:
    msg = _single(
        _edit(lambda x: _patch_member(x, "Purchase", "revenue", {"@of": "Purchase.status", "@default": 0})),
        "ERR_INVALID_MEASURE",
    )
    assert "field.string" in msg
    assert "@default" not in msg


def test_a_measure_that_breaks_m1_and_declares_default_on_a_count_reports_m1_only() -> None:
    msg = _single(
        _edit(lambda x: _patch_member(x, "Purchase", "purchases", {"@of": "Purchase.nope", "@default": 0})),
        "ERR_INVALID_MEASURE",
    )
    assert "names no field 'nope'" in msg
    assert "@default" not in msg


def test_m7_on_a_count_declared_on_an_abstract_base_is_reported_once() -> None:
    m = _inherited_model()
    _children_of(m, "BaseEvent")[3] = {
        "measure.aggregate": {"name": "events", "@agg": "count", "@of": "BaseEvent.id", "@default": 0}
    }
    assert "measure 'events' on entity 'acme::shop::BaseEvent'" in _single(m, "ERR_INVALID_MEASURE")
