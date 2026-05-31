"""Unit tests for the FR-010 extract data model + report. Mirrors Model/Report tests."""
from __future__ import annotations

from metaobjects.render.extract import (
    Coercion,
    FieldKind,
    FieldExtraction,
    FieldSpec,
    Format,
    ExtractOptions,
    ExtractionOutcome,
    ExtractSchema,
    ExtractionReport,
    ExtractionResult,
    Tolerance,
)


# ---- FieldSpec factories ----


def test_scalar_field_spec_builds_with_expected_defaults() -> None:
    f = FieldSpec.scalar("confidence", FieldKind.STRING, True)
    assert f.name == "confidence"
    assert f.kind == FieldKind.STRING
    assert f.required is True
    assert f.array is False
    assert f.enum_values is None
    assert f.enum_alias is None
    assert f.min is None
    assert f.max is None
    assert f.nested is None


def test_enum_field_spec_carries_values_and_aliases() -> None:
    f = FieldSpec.enum_field(
        "tone", True, ["FRIENDLY", "NEUTRAL", "HOSTILE"], {"warm": "FRIENDLY"}
    )
    assert f.kind == FieldKind.ENUM
    assert f.enum_values == ["FRIENDLY", "NEUTRAL", "HOSTILE"]
    assert f.enum_alias is not None
    assert f.enum_alias["warm"] == "FRIENDLY"


def test_enum_field_spec_null_aliases_yields_empty_dict() -> None:
    f = FieldSpec.enum_field("tone", False, ["A", "B"], None)
    assert f.enum_alias == {}


def test_range_field_spec_carries_min_and_max() -> None:
    f = FieldSpec.range_("score", FieldKind.DOUBLE, True, 0.0, 1.0)
    assert f.kind == FieldKind.DOUBLE
    assert f.min == 0.0
    assert f.max == 1.0
    assert f.enum_values is None
    assert f.nested is None


def test_object_field_spec_carries_nested_schema() -> None:
    nested = ExtractSchema(
        Format.JSON, "inner", [FieldSpec.scalar("x", FieldKind.INT, True)]
    )
    f = FieldSpec.object_("payload", True, False, nested)
    assert f.kind == FieldKind.OBJECT
    assert f.required is True
    assert f.array is False
    assert f.nested is not None
    assert f.nested.root_name == "inner"


def test_object_field_spec_array_sets_array_flag() -> None:
    nested = ExtractSchema(Format.JSON, "item")
    f = FieldSpec.object_("items", False, True, nested)
    assert f.array is True


# ---- ExtractSchema ----


def test_schema_carries_format_root_and_fields() -> None:
    schema = ExtractSchema(
        Format.XML, "answer", [FieldSpec.scalar("text", FieldKind.STRING, True)]
    )
    assert schema.format == Format.XML
    assert schema.root_name == "answer"
    assert len(schema.fields) == 1


def test_schema_default_fields_yields_empty_list() -> None:
    schema = ExtractSchema(Format.JSON, "root")
    assert schema.fields == []


# ---- ExtractOptions ----


def test_options_defaults_is_normal_tolerance_empty_maps_and_no_hook() -> None:
    opts = ExtractOptions.defaults()
    assert opts.tolerance == Tolerance.NORMAL
    assert opts.aliases == {}
    assert opts.normalizers == {}
    assert opts.on_field is None


def test_options_with_tolerance_returns_new_instance() -> None:
    opts = ExtractOptions.defaults().with_tolerance(Tolerance.STRICT)
    assert opts.tolerance == Tolerance.STRICT
    assert opts.aliases == {}
    assert opts.on_field is None


# ---- ExtractionReport ----


def test_report_lost_required_filters() -> None:
    r = ExtractionReport()
    r.set("a", FieldExtraction.EXTRACTED)
    r.set("b", FieldExtraction.LOST_REQUIRED)
    r.set("c", FieldExtraction.LOST_REQUIRED)
    r.set("d", FieldExtraction.DEFAULTED)
    assert r.lost_required() == ["b", "c"]
    assert r.has_lost_required()


def test_report_mark_empty() -> None:
    r = ExtractionReport()
    r.mark_empty()
    assert r.is_empty()
    assert not r.has_lost_required()


def test_report_states_returns_snapshot() -> None:
    r = ExtractionReport()
    r.set("x", FieldExtraction.EXTRACTED)
    r.set("y", FieldExtraction.MALFORMED)
    snap = r.states()
    assert len(snap) == 2
    assert snap["x"] == FieldExtraction.EXTRACTED
    assert snap["y"] == FieldExtraction.MALFORMED
    # snapshot is a copy
    snap["z"] = FieldExtraction.EXTRACTED
    assert "z" not in r.states()


def test_report_coercions_returns_all_in_order() -> None:
    r = ExtractionReport()
    r.add_coercion(Coercion("a", "raw", "ALIAS", "alias"))
    r.add_coercion(Coercion("b", "0", "10", "clamp"))
    lst = r.coercions()
    assert len(lst) == 2
    assert lst[0].kind == "alias"
    assert lst[1].kind == "clamp"


def test_report_malformed_filters() -> None:
    r = ExtractionReport()
    r.set("ok", FieldExtraction.EXTRACTED)
    r.set("bad", FieldExtraction.MALFORMED)
    assert r.malformed() == ["bad"]


def test_report_has_lost_required_false_when_none() -> None:
    r = ExtractionReport()
    r.set("x", FieldExtraction.EXTRACTED)
    assert not r.has_lost_required()


# ---- ExtractionOutcome / ExtractionResult ----


def test_outcome_holds_data_and_report() -> None:
    report = ExtractionReport()
    outcome = ExtractionOutcome({"x": 1}, report)
    assert outcome.data["x"] == 1
    assert outcome.report is report


def test_extraction_result_holds_typed_data_and_report() -> None:
    report = ExtractionReport()
    result: ExtractionResult[str] = ExtractionResult("hello", report)
    assert result.data == "hello"
    assert result.report is report


# ---- FieldExtraction enum values match corpus ----


def test_field_extraction_values_match_corpus_expected_json() -> None:
    assert FieldExtraction.EXTRACTED.value == "EXTRACTED"
    assert FieldExtraction.DEFAULTED.value == "DEFAULTED"
    assert FieldExtraction.LOST_OPTIONAL.value == "LOST_OPTIONAL"
    assert FieldExtraction.LOST_REQUIRED.value == "LOST_REQUIRED"
    assert FieldExtraction.MALFORMED.value == "MALFORMED"
