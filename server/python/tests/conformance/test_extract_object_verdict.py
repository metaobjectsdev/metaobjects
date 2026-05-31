"""Gold-standard "verdict oracle" proof for the Phase B runtime extract
(``extract_object``). Python port of the JVM ``MetaObjectExtractorVerdictTest`` /
TS ``extract-object-verdict.test.ts``.

A representative adjudication-verdict ``object.value`` graph — scalars (incl. an
enum with a ``@default``), an enum-array, and two arrays-of-records — is extracted
from a deliberately DIRTY XML response (preamble + whitespace, an empty array, an
uncoercible enum value, an omitted defaulted field). Proves the full metadata-driven
pipeline: ``extract_schema_for`` → engine → ``assemble`` into a typed object graph
with correct back-references (``get_meta_data``), generalized ``@default`` fill,
enum-array uncoercible-dropped, empty-array → empty list, never-raises, and the
``or_throw`` opt-in gate. Generic fixture — no private/domain names.
"""
from __future__ import annotations

import json

import pytest

from metaobjects import (
    ExtractError,
    ValueObject,
    load_string,
    or_throw,
    extract_object,
    extract_schema_for,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.render.extract import FieldKind, FieldExtraction, Format

PKG = "com::example::verdict"

# A generic adjudication-verdict metamodel (no private/domain names). identifier-safe
# enum members (e.g. "not_ready").
VERDICT_META = {
    "metadata.root": {
        "package": PKG,
        "children": [
            {
                "object.value": {
                    "name": "ThreadCheck",
                    "children": [
                        {"field.string": {"name": "id"}},
                        {"field.enum": {"name": "resolved", "@values": ["yes", "no"]}},
                        {"field.string": {"name": "reason"}},
                    ],
                }
            },
            {
                "object.value": {
                    "name": "EventCheck",
                    "children": [
                        {"field.string": {"name": "id"}},
                        {"field.enum": {"name": "fires", "@values": ["yes", "no"]}},
                        {"field.string": {"name": "reason"}},
                    ],
                }
            },
            {
                "object.value": {
                    "name": "Verdict",
                    "children": [
                        {"field.boolean": {"name": "objective_complete"}},
                        {"field.string": {"name": "objective_status"}},
                        {
                            "field.enum": {
                                "name": "arc_transition",
                                "@values": ["ready", "not_ready"],
                                "@default": "not_ready",
                            }
                        },
                        {
                            "field.enum": {
                                "name": "tags",
                                "isArray": True,
                                "@values": ["a", "b", "c"],
                            }
                        },
                        {
                            "field.object": {
                                "name": "thread_checks",
                                "isArray": True,
                                "@objectRef": f"{PKG}::ThreadCheck",
                            }
                        },
                        {
                            "field.object": {
                                "name": "event_checks",
                                "isArray": True,
                                "@objectRef": f"{PKG}::EventCheck",
                            }
                        },
                    ],
                }
            },
        ],
    }
}


def _load_root() -> MetaRoot:
    result = load_string(json.dumps(VERDICT_META))
    assert result.errors == [], f"load errors: {result.errors}"
    assert isinstance(result.root, MetaRoot)
    return result.root


def _find_object(root: MetaRoot, name: str) -> MetaObject:
    obj = next(
        (c for c in root.children() if isinstance(c, MetaObject) and c.name == name),
        None,
    )
    assert obj is not None, f"no object {name}"
    return obj


def _field_value(mo: MetaObject, name: str, obj: object) -> object:
    f = mo.get_meta_field(name)
    assert f is not None, f"no field {name}"
    return f.get_value(obj)


# Dirty XML: chat preamble + whitespace before the root; arc_transition OMITTED
# (→ @default "not_ready", DEFAULTED); tags contains an uncoercible member ("zzz")
# alongside a valid one; event_checks is an EMPTY element (→ empty list, not null);
# two well-formed thread_checks.
_DIRTY_XML = (
    "Sure — here is the verdict you asked for:\n\n"
    "<Verdict>\n"
    "  <objective_complete>true</objective_complete>\n"
    "  <objective_status>partially met</objective_status>\n"
    "  <tags>a</tags>\n"
    "  <tags>zzz</tags>\n"
    "  <thread_checks><id>T1</id><resolved>yes</resolved>"
    "<reason>closed cleanly</reason></thread_checks>\n"
    "  <thread_checks><id>T2</id><resolved>no</resolved>"
    "<reason>still open</reason></thread_checks>\n"
    "  <event_checks></event_checks>\n"
    "</Verdict>\n"
    "\nLet me know if you need anything else!"
)


def test_dirty_xml_extracts_into_typed_object_graph() -> None:
    root = _load_root()
    verdict_mo = _find_object(root, "Verdict")
    thread_mo = _find_object(root, "ThreadCheck")

    result = extract_object(verdict_mo, _DIRTY_XML, Format.XML)

    # ---- never throws; produced a typed Verdict object with the right back-ref ----
    verdict = result.data
    assert isinstance(verdict, ValueObject)
    assert verdict.get_meta_data() is verdict_mo  # back-reference

    # ---- scalars ----
    assert _field_value(verdict_mo, "objective_complete", verdict) is True
    assert _field_value(verdict_mo, "objective_status", verdict) == "partially met"

    # ---- @default fill: arc_transition was omitted → DEFAULTED to "not_ready" ----
    assert _field_value(verdict_mo, "arc_transition", verdict) == "not_ready"
    assert result.report.states()["arc_transition"] == FieldExtraction.DEFAULTED

    # ---- enum-array: valid element kept, uncoercible "zzz" dropped (partial) ----
    tags = _field_value(verdict_mo, "tags", verdict)
    assert tags == ["a"]
    # per-element classification
    assert result.report.states()["tags[0]"] == FieldExtraction.EXTRACTED
    assert result.report.states()["tags[1]"] == FieldExtraction.MALFORMED

    # ---- array-of-records: thread_checks fully populated as typed children ----
    threads = _field_value(verdict_mo, "thread_checks", verdict)
    assert isinstance(threads, list)
    assert len(threads) == 2

    t0 = threads[0]
    assert isinstance(t0, ValueObject)
    assert t0.get_meta_data() is thread_mo  # nested back-reference
    assert _field_value(thread_mo, "id", t0) == "T1"
    assert _field_value(thread_mo, "resolved", t0) == "yes"
    assert _field_value(thread_mo, "reason", t0) == "closed cleanly"

    t1 = threads[1]
    assert _field_value(thread_mo, "id", t1) == "T2"
    assert _field_value(thread_mo, "resolved", t1) == "no"

    # ---- empty/self-closing array → empty list (NOT None) ----
    events = _field_value(verdict_mo, "event_checks", verdict)
    assert isinstance(events, list)
    assert len(events) == 0

    # ---- or_throw(): no required field was lost → returns the data unharmed ----
    assert or_throw(result) is verdict


def test_or_throw_raises_when_required_field_lost() -> None:
    strict_meta = {
        "metadata.root": {
            "package": PKG,
            "children": [
                {
                    "object.value": {
                        "name": "Strict",
                        "children": [
                            {"field.string": {"name": "needed", "@required": True}}
                        ],
                    }
                }
            ],
        }
    }
    result_load = load_string(json.dumps(strict_meta))
    assert result_load.errors == []
    assert isinstance(result_load.root, MetaRoot)
    strict_mo = _find_object(result_load.root, "Strict")

    # Empty JSON object — "needed" is absent → LOST_REQUIRED.
    result = extract_object(strict_mo, "{}", Format.JSON)
    assert result.report.has_lost_required() is True

    with pytest.raises(ExtractError) as exc:
        or_throw(result)
    assert "needed" in exc.value.lost_required


def test_extract_never_raises_on_total_garbage_and_still_defaults() -> None:
    root = _load_root()
    verdict_mo = _find_object(root, "Verdict")

    result = extract_object(verdict_mo, "%%% not even close %%%")
    assert result.data is not None
    obj = result.data
    assert isinstance(obj, ValueObject)
    # arc_transition still defaults even on a degenerate response.
    assert _field_value(verdict_mo, "arc_transition", obj) == "not_ready"


def test_extract_schema_for_mirrors_metadata_shape() -> None:
    root = _load_root()
    verdict_mo = _find_object(root, "Verdict")

    schema = extract_schema_for(verdict_mo, Format.XML)
    assert schema.format == Format.XML
    assert schema.root_name == "Verdict"

    by_name = {f.name: f for f in schema.fields}

    arc = by_name["arc_transition"]
    assert arc.kind == FieldKind.ENUM
    assert arc.array is False
    assert arc.default_value == "not_ready"
    assert arc.enum_values == ["ready", "not_ready"]

    tags = by_name["tags"]
    assert tags.kind == FieldKind.ENUM
    assert tags.array is True

    threads = by_name["thread_checks"]
    assert threads.kind == FieldKind.OBJECT
    assert threads.array is True
    assert threads.nested is not None
    assert threads.nested.root_name == "ThreadCheck"
