"""Unit tests for ``recover`` — FR-010 entry-point pipeline. Mirrors Recover(Test|Tests)."""
from __future__ import annotations

from metaobjects.render.recover import (
    FieldKind,
    FieldRecovery,
    FieldSpec,
    Format,
    RecoverSchema,
    recover,
)


def _json_answer() -> RecoverSchema:
    return RecoverSchema(
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


def test_clean_json_all_recovered() -> None:
    o = recover('{"text":"hi","confidence":"HIGH","note":"n"}', _json_answer())
    assert o.data["text"] == "hi"
    assert o.data["confidence"] == "HIGH"
    assert o.report.states()["confidence"] == FieldRecovery.RECOVERED
    assert not o.report.has_lost_required()


def test_fenced_and_prose_wrapped_still_recovers() -> None:
    dirty = 'Sure!\n```json\n{"text":"hi","confidence":"HIGH"}\n```\nDone.'
    o = recover(dirty, _json_answer())
    assert o.data["text"] == "hi"
    assert o.report.states()["note"] == FieldRecovery.LOST_OPTIONAL


def test_alias_folds_off_vocab() -> None:
    o = recover('{"text":"hi","confidence":"medium"}', _json_answer())
    assert o.data["confidence"] == "OK"
    assert o.report.states()["confidence"] == FieldRecovery.RECOVERED


def test_off_vocab_required_is_malformed() -> None:
    o = recover('{"text":"hi","confidence":"banana"}', _json_answer())
    assert o.report.states()["confidence"] == FieldRecovery.MALFORMED
    assert "confidence" not in o.data


def test_missing_required_is_lost_required() -> None:
    o = recover('{"text":"hi"}', _json_answer())
    assert "confidence" in o.report.lost_required()


def test_empty_response_flags_empty_and_all_required_lost() -> None:
    o = recover("   ", _json_answer())
    assert o.report.is_empty()
    assert "text" in o.report.lost_required()
    assert "confidence" in o.report.lost_required()


def test_xml_unclosed_tag_recovers() -> None:
    xml = RecoverSchema(
        Format.XML,
        "answer",
        [
            FieldSpec.scalar("text", FieldKind.STRING, True),
            FieldSpec.enum_field("confidence", True, ["HIGH"], {}),
        ],
    )
    o = recover("<answer><text>hi<confidence>HIGH</confidence></answer>", xml)
    assert o.data["text"] == "hi"
    assert o.data["confidence"] == "HIGH"


def test_never_throws_on_garbage() -> None:
    o = recover("@@@ totally broken @@@", _json_answer())
    assert o.report.is_empty()


def test_json_string_array_recovers_as_list() -> None:
    s = RecoverSchema(
        Format.JSON,
        "answer",
        [FieldSpec(name="tags", kind=FieldKind.STRING, required=False, array=True)],
    )
    o = recover('{"tags":["a","b"]}', s)
    assert o.data["tags"] == ["a", "b"]
    assert o.report.states()["tags"] == FieldRecovery.RECOVERED


def test_json_enum_array_coerces_per_element() -> None:
    s = RecoverSchema(
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
    o = recover('{"tones":["warm","LOW"]}', s)
    assert o.data["tones"] == ["HIGH", "LOW"]
    assert o.report.states()["tones"] == FieldRecovery.RECOVERED


def test_list_for_scalar_field_is_malformed() -> None:
    s = RecoverSchema(
        Format.JSON, "answer", [FieldSpec.scalar("text", FieldKind.STRING, True)]
    )
    o = recover('{"text":["a","b"]}', s)
    assert o.report.states()["text"] == FieldRecovery.MALFORMED
    assert "text" not in o.data


def test_object_field_with_scalar_value_is_malformed() -> None:
    nested = RecoverSchema(
        Format.JSON, "meta", [FieldSpec.scalar("n", FieldKind.STRING, True)]
    )
    s = RecoverSchema(
        Format.JSON, "answer", [FieldSpec.object_("meta", True, False, nested)]
    )
    o = recover('{"meta":"oops"}', s)
    assert o.report.states()["meta"] == FieldRecovery.MALFORMED


def test_truncated_value_is_malformed_not_lost() -> None:
    o = recover('{"text":"hi","confidence":', _json_answer())
    assert o.data["text"] == "hi"
    assert o.report.states()["confidence"] == FieldRecovery.MALFORMED
    assert not o.report.is_empty()


def test_partial_enum_array_is_malformed_but_keeps_valid_elements() -> None:
    s = RecoverSchema(
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
    o = recover('{"tones":["HIGH","grape"]}', s)
    assert o.report.states()["tones"] == FieldRecovery.MALFORMED
    assert o.data["tones"] == ["HIGH"]  # valid element retained


def test_nested_object_recurses() -> None:
    # Python port implements nested-object recovery (parity with the Java/C# engine,
    # which both recurse on OBJECT fields with a nested schema).
    nested = RecoverSchema(
        Format.JSON, "meta", [FieldSpec.scalar("n", FieldKind.STRING, True)]
    )
    s = RecoverSchema(
        Format.JSON, "answer", [FieldSpec.object_("meta", True, False, nested)]
    )
    o = recover('{"meta":{"n":"7"}}', s)
    assert o.data["meta"] == {"n": "7"}
    assert o.report.states()["meta"] == FieldRecovery.RECOVERED
    assert o.report.states()["meta.n"] == FieldRecovery.RECOVERED
