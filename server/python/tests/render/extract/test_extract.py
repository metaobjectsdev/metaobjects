"""Unit tests for ``extract`` — FR-010 entry-point pipeline. Mirrors Extract(Test|Tests)."""
from __future__ import annotations

from metaobjects.render.extract import (
    FieldKind,
    FieldExtraction,
    FieldSpec,
    Format,
    ExtractSchema,
    extract,
)


def _json_answer() -> ExtractSchema:
    return ExtractSchema(
        Format.JSON,
        "answer",
        [
            FieldSpec.scalar("text", FieldKind.STRING, True),
            FieldSpec.enum_field(
                "confidence", True, ["HIGH", "OK", "LOW"], {"medium": "OK"}
            ),
            FieldSpec.scalar("note", FieldKind.STRING, False),
        ],
    )


def test_clean_json_all_extracted() -> None:
    o = extract('{"text":"hi","confidence":"HIGH","note":"n"}', _json_answer())
    assert o.data["text"] == "hi"
    assert o.data["confidence"] == "HIGH"
    assert o.report.states()["confidence"] == FieldExtraction.EXTRACTED
    assert not o.report.has_lost_required()


def test_fenced_and_prose_wrapped_still_extracts() -> None:
    dirty = 'Sure!\n```json\n{"text":"hi","confidence":"HIGH"}\n```\nDone.'
    o = extract(dirty, _json_answer())
    assert o.data["text"] == "hi"
    assert o.report.states()["note"] == FieldExtraction.LOST_OPTIONAL


def test_alias_folds_off_vocab() -> None:
    o = extract('{"text":"hi","confidence":"medium"}', _json_answer())
    assert o.data["confidence"] == "OK"
    assert o.report.states()["confidence"] == FieldExtraction.EXTRACTED


def test_off_vocab_required_is_malformed() -> None:
    o = extract('{"text":"hi","confidence":"banana"}', _json_answer())
    assert o.report.states()["confidence"] == FieldExtraction.MALFORMED
    assert "confidence" not in o.data


def test_missing_required_is_lost_required() -> None:
    o = extract('{"text":"hi"}', _json_answer())
    assert "confidence" in o.report.lost_required()


def test_empty_response_flags_empty_and_all_required_lost() -> None:
    o = extract("   ", _json_answer())
    assert o.report.is_empty()
    assert "text" in o.report.lost_required()
    assert "confidence" in o.report.lost_required()


def test_xml_unclosed_tag_extracts() -> None:
    xml = ExtractSchema(
        Format.XML,
        "answer",
        [
            FieldSpec.scalar("text", FieldKind.STRING, True),
            FieldSpec.enum_field("confidence", True, ["HIGH"], {}),
        ],
    )
    o = extract("<answer><text>hi<confidence>HIGH</confidence></answer>", xml)
    assert o.data["text"] == "hi"
    assert o.data["confidence"] == "HIGH"


def test_never_throws_on_garbage() -> None:
    o = extract("@@@ totally broken @@@", _json_answer())
    assert o.report.is_empty()


def test_json_string_array_extracts_as_list() -> None:
    s = ExtractSchema(
        Format.JSON,
        "answer",
        [FieldSpec(name="tags", kind=FieldKind.STRING, required=False, array=True)],
    )
    o = extract('{"tags":["a","b"]}', s)
    assert o.data["tags"] == ["a", "b"]
    assert o.report.states()["tags"] == FieldExtraction.EXTRACTED


def test_json_enum_array_coerces_per_element() -> None:
    s = ExtractSchema(
        Format.JSON,
        "answer",
        [
            FieldSpec(
                name="tones",
                kind=FieldKind.ENUM,
                required=False,
                array=True,
                enum_values=["HIGH", "LOW"],
                enum_alias={"warm": "HIGH"},
            )
        ],
    )
    o = extract('{"tones":["warm","LOW"]}', s)
    assert o.data["tones"] == ["HIGH", "LOW"]
    assert o.report.states()["tones"] == FieldExtraction.EXTRACTED


def test_list_for_scalar_field_is_malformed() -> None:
    s = ExtractSchema(
        Format.JSON, "answer", [FieldSpec.scalar("text", FieldKind.STRING, True)]
    )
    o = extract('{"text":["a","b"]}', s)
    assert o.report.states()["text"] == FieldExtraction.MALFORMED
    assert "text" not in o.data


def test_object_field_with_scalar_value_is_malformed() -> None:
    nested = ExtractSchema(
        Format.JSON, "meta", [FieldSpec.scalar("n", FieldKind.STRING, True)]
    )
    s = ExtractSchema(
        Format.JSON, "answer", [FieldSpec.object_("meta", True, False, nested)]
    )
    o = extract('{"meta":"oops"}', s)
    assert o.report.states()["meta"] == FieldExtraction.MALFORMED


def test_truncated_value_is_malformed_not_lost() -> None:
    o = extract('{"text":"hi","confidence":', _json_answer())
    assert o.data["text"] == "hi"
    assert o.report.states()["confidence"] == FieldExtraction.MALFORMED
    assert not o.report.is_empty()


def test_partial_enum_array_is_malformed_but_keeps_valid_elements() -> None:
    s = ExtractSchema(
        Format.JSON,
        "answer",
        [
            FieldSpec(
                name="tones",
                kind=FieldKind.ENUM,
                required=False,
                array=True,
                enum_values=["HIGH", "LOW"],
                enum_alias={},
            )
        ],
    )
    o = extract('{"tones":["HIGH","grape"]}', s)
    assert o.report.states()["tones"] == FieldExtraction.MALFORMED
    assert o.data["tones"] == ["HIGH"]  # valid element retained


def test_nested_object_recurses() -> None:
    # Python port implements nested-object extraction (parity with the Java/C# engine,
    # which both recurse on OBJECT fields with a nested schema).
    nested = ExtractSchema(
        Format.JSON, "meta", [FieldSpec.scalar("n", FieldKind.STRING, True)]
    )
    s = ExtractSchema(
        Format.JSON, "answer", [FieldSpec.object_("meta", True, False, nested)]
    )
    o = extract('{"meta":{"n":"7"}}', s)
    assert o.data["meta"] == {"n": "7"}
    assert o.report.states()["meta"] == FieldExtraction.EXTRACTED
    assert o.report.states()["meta.n"] == FieldExtraction.EXTRACTED


# ---- FR-011 DEFAULTED classification + @default absent-fill ----


def test_coerce_default_classifies_defaulted() -> None:
    s = ExtractSchema(
        Format.JSON,
        "task",
        [
            FieldSpec.enum_field(
                "status",
                True,
                ["IN_PROGRESS", "DONE"],
                {},
                coerce_default="DONE",
                normalize="none",
            )
        ],
    )
    o = extract('{"status":"banana"}', s)
    assert o.data["status"] == "DONE"
    assert o.report.states()["status"] == FieldExtraction.DEFAULTED


def test_default_absent_fill_satisfies_required() -> None:
    s = ExtractSchema(
        Format.JSON,
        "task",
        [
            FieldSpec.scalar("title", FieldKind.STRING, True),
            FieldSpec.enum_field(
                "status", True, ["IN_PROGRESS", "DONE"], {}, default_value="IN_PROGRESS"
            ),
        ],
    )
    o = extract('{"title":"ship it"}', s)
    assert o.data["status"] == "IN_PROGRESS"
    assert o.report.states()["status"] == FieldExtraction.DEFAULTED
    # @default fills the value, so the required field is NOT lost.
    assert not o.report.has_lost_required()


def test_normalized_match_classifies_extracted_not_defaulted() -> None:
    s = ExtractSchema(
        Format.JSON,
        "task",
        [
            FieldSpec.enum_field(
                "status", True, ["IN_PROGRESS"], {}, normalize="strip"
            )
        ],
    )
    o = extract('{"status":"In-Progress!"}', s)
    assert o.data["status"] == "IN_PROGRESS"
    assert o.report.states()["status"] == FieldExtraction.EXTRACTED
