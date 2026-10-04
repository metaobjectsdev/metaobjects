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

from metaobjects import load_directory
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_REPORT
from metaobjects.meta.core.reporting.report_shape import report_shape
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.shared.base_types import TYPE_OBJECT

CORPUS = Path(__file__).parents[3] / "fixtures" / "persistence-conformance"


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
        # ADR-0039: own — the report's own declared read-only source names its view; a
        # report inherits no source, and a sourceless one has no view.
        source = next(
            (c for c in report.own_children() if isinstance(c, MetaSource) and c.is_read_only()), None
        )
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
