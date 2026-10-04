"""FR-044 Plan 2 — Table B (a report's derived fields), byte-matched across ports.

TypeScript produces ``fixtures/persistence-conformance/report-shapes.json`` from the
canonical model; every other port derives the same shapes from the same model and
compares BYTES, in a container-free test, so the derivation cannot drift between ports.
The format is a contract (reports in declaration order; keys ``report, from, view,
fields``, then per field ``name, role, subType, required, typeSource``; two-space
indent; one trailing newline), and ``type_source`` is the resolution key of the entity
that DECLARES the ``@of`` field, a dot, and the field name.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import load_directory
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import (
    OBJECT_REPORT_ATTR_DIMENSIONS,
    OBJECT_REPORT_ATTR_FROM,
    OBJECT_REPORT_ATTR_MEASURES,
    OBJECT_SUBTYPE_REPORT,
)
from metaobjects.meta.core.reporting.report_accessors import (
    report_measure_item_name,
    report_measure_item_owner,
)
from metaobjects.meta.core.reporting.report_read_model import report_read_source
from metaobjects.meta.core.reporting.report_shape import report_shape
from metaobjects.shared.base_types import TYPE_OBJECT

CORPUS = Path(__file__).parents[3] / "fixtures" / "persistence-conformance"


def _file(package: str, children: list) -> InMemoryStringSource:
    return InMemoryStringSource(
        json.dumps({"metadata.root": {"package": package, "children": children}}), f"meta.{package}.json"
    )


def _load(*files: InMemoryStringSource):
    result = MetaDataLoader().load(list(files))
    assert result.errors == [], [e.message for e in result.errors]
    return result.root


def _object(root, name: str) -> MetaObject:
    return next(c for c in root.children() if c.type == TYPE_OBJECT and c.name == name)


#: A minimal entity with one count measure, for the tests that are about the report.
_SALE = {
    "object.entity": {
        "name": "Sale",
        "children": [
            {"source.rdb": {"@table": "sales"}},
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            {"measure.aggregate": {"name": "sales", "@agg": "count", "@of": "Sale.id"}},
        ],
    }
}


def _root():
    result = load_directory(CORPUS / "canonical")
    assert not result.errors, "\n".join(e.message for e in result.errors)
    return result.root


def _type_source(field: MetaField | None) -> str | None:
    if field is None:
        return None
    owner = field.parent
    assert owner is not None, f"field '{field.name}' has no owning entity"
    return f"{owner.resolution_key()}.{field.name}"


def generate_report_shapes_json(root) -> str:
    reports = []
    # ADR-0039: resolving — the root is never extended, so children() == own_children().
    for report in (c for c in root.children() if c.type == TYPE_OBJECT):
        if report.sub_type != OBJECT_SUBTYPE_REPORT:
            continue
        shape = report_shape(report, root)
        # The source the lowering names and the runtime reads: the report's own read-only
        # source with @role primary, else its first own read-only source.
        source = report_read_source(report)
        reports.append(
            {
                "report": report.resolution_key(),
                "from": shape.from_.resolution_key(),
                "view": None if source is None else source.physical_name(),
                "fields": [
                    {
                        "name": f.name,
                        "role": f.role,
                        "subType": f.sub_type,
                        "required": f.required,
                        "typeSource": _type_source(f.type_source),
                    }
                    for f in shape.fields
                ],
            }
        )
    # json.dumps(indent=2) is JSON.stringify(_, null, 2) for this data: same layout,
    # empty containers aside (none occur), and no non-ASCII to escape.
    return json.dumps({"reports": reports}, indent=2, ensure_ascii=False) + "\n"


def test_derived_shapes_byte_match_the_committed_artifact() -> None:
    expected = (CORPUS / "report-shapes.json").read_text(encoding="utf-8")
    assert generate_report_shapes_json(_root()) == expected


def test_the_canonical_model_has_six_reports() -> None:
    reports = [c for c in _root().children() if c.type == TYPE_OBJECT and c.sub_type == OBJECT_SUBTYPE_REPORT]
    assert len(reports) == 6
    assert all(isinstance(r, MetaObject) for r in reports)


def test_the_view_is_the_primary_read_only_source_else_the_first() -> None:
    """The artifact's ``view`` is the source the lowering names and the runtime reads: a
    replica declared BEFORE the primary does not name the view."""
    root = _load(
        _file(
            "shop",
            [
                _SALE,
                {
                    "object.report": {
                        "name": "R",
                        "@from": "Sale",
                        "@measures": ["sales"],
                        "children": [
                            {"source.rdb": {"name": "replica", "@kind": "view", "@view": "v_replica", "@role": "replica"}},
                            {"source.rdb": {"name": "main", "@kind": "view", "@view": "v_primary"}},
                        ],
                    }
                },
            ],
        )
    )
    assert json.loads(generate_report_shapes_json(root))["reports"][0]["view"] == "v_primary"


# ---------------------------------------------------------------------------
# Reference resolution: the shape must agree with the loader's validate_reporting
# about what a reference names, or a model that loads clean fails (or is silently
# mistyped) when it is read. The same cases as the TypeScript report-shape.test.ts.
# ---------------------------------------------------------------------------

#: ``a::Base`` (abstract): members whose bare ``@of`` names ``Base``.
_SHARED_BASE = {
    "object.entity": {
        "name": "Base",
        "abstract": True,
        "children": [
            {"field.long": {"name": "id"}},
            {"field.string": {"name": "kind"}},
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            {"dimension.attribute": {"name": "kind", "@of": "Base.kind"}},
            {"measure.aggregate": {"name": "events", "@agg": "count", "@of": "Base.id"}},
            {"measure.aggregate": {"name": "lastKind", "@agg": "max", "@of": "Base.kind"}},
        ],
    }
}

_DECOY = {
    "object.entity": {"name": "Base", "children": [{"field.int": {"name": "id"}}, {"field.int": {"name": "kind"}}]}
}


def _ev(extra: list | None = None) -> dict:
    return {
        "object.entity": {
            "name": "Ev",
            "extends": "a::Base",
            "children": [{"source.rdb": {"@table": "evs"}}, *(extra or [])],
        }
    }


def _ev_report(**attrs) -> dict:
    return {
        "object.report": {
            "name": "R",
            "@from": "Ev",
            "@dimensions": ["kind"],
            "@measures": ["events", "lastKind"],
            **attrs,
            "children": [{"source.rdb": {"@kind": "view", "@view": "v_r"}}],
        }
    }


def _typed(root) -> list[tuple[str, str, str | None]]:
    shape = report_shape(_object(root, "R"), root)
    return [
        (f.name, f.sub_type, None if f.type_source is None else f.type_source.parent.resolution_key())
        for f in shape.fields
    ]


def test_a_bare_of_on_a_member_inherited_from_another_package_resolves_in_the_declaring_package() -> None:
    root = _load(_file("a", [_SHARED_BASE]), _file("b", [_ev(), _ev_report()]))
    assert _typed(root) == [("kind", "string", "a::Base"), ("events", "long", None), ("lastKind", "string", "a::Base")]


def test_a_same_named_decoy_in_the_reports_package_does_not_capture_the_reference() -> None:
    root = _load(_file("a", [_SHARED_BASE]), _file("b", [_DECOY, _ev(), _ev_report()]))
    assert _typed(root) == [("kind", "string", "a::Base"), ("events", "long", None), ("lastKind", "string", "a::Base")]


def test_without_via_the_field_is_read_from_from_so_a_field_from_redeclares_wins() -> None:
    root = _load(_file("a", [_SHARED_BASE]), _file("b", [_ev([{"field.int": {"name": "kind"}}]), _ev_report()]))
    assert _typed(root) == [("kind", "int", "b::Ev"), ("events", "long", None), ("lastKind", "int", "b::Ev")]


def test_a_dotted_measures_item_names_the_measure_by_its_last_segment() -> None:
    root = _load(
        _file("a", [_SHARED_BASE]),
        _file("b", [_ev(), _ev_report(**{"@measures": ["Ev.events", "a::Base.lastKind"]})]),
    )
    assert [f[0] for f in _typed(root)] == ["kind", "events", "lastKind"]


def test_report_measure_item_name_is_the_last_segment() -> None:
    assert report_measure_item_name("total") == "total"
    assert report_measure_item_name("Sale.total") == "total"
    assert report_measure_item_name("acme::shop::Sale.total") == "total"
    assert report_measure_item_owner("total") is None
    assert report_measure_item_owner("acme::shop::Sale.total") == "acme::shop::Sale"


def _stray(package: str, from_: str, attr: str, item: str) -> MetaObject:
    """A report built in code (never added to the root): what the loader would refuse."""
    report = MetaObject(TYPE_OBJECT, OBJECT_SUBTYPE_REPORT, "Stray")
    report.package = package
    report.set_attr(OBJECT_REPORT_ATTR_FROM, from_)
    report.set_attr(attr, [item])
    return report


def test_a_dotted_measures_item_whose_qualifier_is_not_from_or_an_ancestor_does_not_resolve() -> None:
    root = _load(_file("a", [_SHARED_BASE]), _file("b", [_DECOY, _ev(), _ev_report()]))
    # Past the loader, which refuses these as ERR_INVALID_REPORT / ERR_REPORT_FOREIGN_MEASURE.
    with pytest.raises(ValueError) as e:
        report_shape(_stray("b", "Ev", OBJECT_REPORT_ATTR_MEASURES, "Nope.events"), root)
    assert str(e.value) == "report 'Stray': measure 'Nope.events' on 'Ev' does not resolve."
    # The qualifier resolves in the REPORT's package: b::Base is the decoy, not an ancestor of Ev.
    with pytest.raises(ValueError) as e:
        report_shape(_stray("b", "Ev", OBJECT_REPORT_ATTR_MEASURES, "Base.events"), root)
    assert str(e.value) == "report 'Stray': measure 'Base.events' on 'Ev' does not resolve."


def test_a_time_dimension_item_with_no_grain_or_a_grain_outside_the_closed_set_does_not_resolve() -> None:
    root = _root()
    with pytest.raises(ValueError) as e:
        report_shape(_stray("fitness", "Program", OBJECT_REPORT_ATTR_DIMENSIONS, "createdAt"), root)
    assert str(e.value) == "report 'Stray': time dimension 'createdAt' grain '' does not resolve."
    with pytest.raises(ValueError) as e:
        report_shape(_stray("fitness", "Program", OBJECT_REPORT_ATTR_DIMENSIONS, "createdAt:fortnight"), root)
    assert str(e.value) == "report 'Stray': time dimension 'createdAt' grain 'fortnight' does not resolve."


# ---------------------------------------------------------------------------
# Table B rows the canonical model does not contain
# ---------------------------------------------------------------------------

_CUBE = {
    "object.entity": {
        "name": "Sale",
        "extends": "Base",
        "children": [
            {"source.rdb": {"@table": "sales"}},
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            {"field.decimal": {"name": "weight", "@precision": 10, "@scale": 2}},
            {"field.double": {"name": "score"}},
            {"field.float": {"name": "ratio"}},
            {"field.string": {"name": "region", "@required": True, "@maxLength": 8}},
            {"field.timestamp": {"name": "bookedAt", "@localTime": True}},
            {"dimension.attribute": {"name": "region", "@of": "Sale.region"}},
            {"dimension.time": {"name": "bookedAt", "@of": "Sale.bookedAt", "@grains": ["hour", "day"]}},
            {"measure.aggregate": {"name": "revenue", "@agg": "sum", "@of": "Sale.amountCents"}},
            {"measure.aggregate": {"name": "avgRevenue", "@agg": "avg", "@of": "Sale.amountCents"}},
            {"measure.aggregate": {"name": "totalWeight", "@agg": "sum", "@of": "Sale.weight"}},
            {"measure.aggregate": {"name": "avgWeight", "@agg": "avg", "@of": "Sale.weight"}},
            {"measure.aggregate": {"name": "totalScore", "@agg": "sum", "@of": "Sale.score"}},
            {"measure.aggregate": {"name": "avgScore", "@agg": "avg", "@of": "Sale.score"}},
            {"measure.aggregate": {"name": "totalRatio", "@agg": "sum", "@of": "Sale.ratio"}},
            {"measure.aggregate": {"name": "avgRatio", "@agg": "avg", "@of": "Sale.ratio"}},
            {"measure.aggregate": {"name": "maxRevenue", "@agg": "max", "@of": "Sale.amountCents"}},
            {"measure.aggregate": {"name": "minWeight", "@agg": "min", "@of": "Sale.weight"}},
        ],
    }
}

_CUBE_BASE = {
    "object.entity": {
        "name": "Base",
        "abstract": True,
        "children": [{"field.currency": {"name": "amountCents", "@required": True, "@currency": "USD"}}],
    }
}

_CUBE_REPORT = {
    "object.report": {
        "name": "R",
        "@from": "Sale",
        "@dimensions": ["region", "bookedAt:hour", "bookedAt:day"],
        "@measures": [
            "revenue", "avgRevenue", "totalWeight", "avgWeight", "totalScore", "avgScore",
            "totalRatio", "avgRatio", "maxRevenue", "minWeight",
        ],
    }
}


def test_sum_avg_min_and_max_rows_by_of_subtype() -> None:
    root = _load(_file("shop", [_CUBE_BASE, _CUBE, _CUBE_REPORT]))
    fields = {f.name: f for f in report_shape(_object(root, "R"), root).fields}

    def row(name: str) -> tuple[str, bool, str | None]:
        f = fields[name]
        return (f.sub_type, f.required, _type_source(f.type_source))

    # sum: currency stays currency (and carries its type source); int/long -> long;
    # double/float -> double; anything else -> decimal. No sum is required.
    assert row("revenue") == ("currency", False, "shop::Base.amountCents")
    assert row("totalWeight") == ("decimal", False, None)
    assert row("totalScore") == ("double", False, None)
    assert row("totalRatio") == ("double", False, None)
    # avg: double/float -> double, anything else -> decimal; never a type source.
    assert row("avgRevenue") == ("decimal", False, None)
    assert row("avgWeight") == ("decimal", False, None)
    assert row("avgScore") == ("double", False, None)
    assert row("avgRatio") == ("double", False, None)
    # min / max keep the @of field's subtype and name it as the type source: the entity
    # that DECLARES the field, which for an inherited field is the base.
    assert row("maxRevenue") == ("currency", False, "shop::Base.amountCents")
    assert row("minWeight") == ("decimal", False, "shop::Sale.weight")
    # Dimensions: required only from the @of field's own @required; an hour bucket keeps
    # the field as its type source (for @localTime), a coarser one is a bare date.
    assert row("region") == ("string", True, "shop::Sale.region")
    assert row("bookedAtHour") == ("timestamp", False, "shop::Sale.bookedAt")
    assert row("bookedAtDay") == ("date", False, None)


def test_a_sourceless_report_has_a_shape_and_no_view() -> None:
    root = _load(_file("shop", [_CUBE_BASE, _CUBE, _CUBE_REPORT]))
    assert json.loads(generate_report_shapes_json(root))["reports"][0]["view"] is None
