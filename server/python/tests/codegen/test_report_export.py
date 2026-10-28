"""Report export (``docs/features/api-contract.md``, "Report export"): the shared writers, the
request helper, the ``report-export`` generator, and the rule that the router grows a
``?format=`` branch only when that generator is in the run."""
from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator_registry import GeneratorBuildContext, list_generators
from metaobjects.codegen.generators.report_export_generator import (
    ReportExportGenerator,
    report_export_generator,
)
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.runtime import report_export as rt

_CORPUS = Path(__file__).parents[3].parent / "fixtures" / "api-contract-conformance" / "report"


def _writer(**opts):
    """The generated shared writer module, imported."""
    src = ReportExportGenerator(**opts).render_writer()
    path = Path(tempfile.mkdtemp()) / f"w_{uuid.uuid4().hex}.py"
    path.write_text(src, encoding="utf-8")
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[path.stem] = mod  # dataclasses resolves annotations through sys.modules
    spec.loader.exec_module(mod)
    return mod


# --- shared writer ---------------------------------------------------------------------


def test_csv_quoting_crlf_and_null() -> None:
    w = _writer()
    cols = [w.ExportColumn("a", "string"), w.ExportColumn("n", "scalar")]
    rows = [{"a": 'say "hi"', "n": 1}, {"a": "x,y", "n": None}, {"a": "l1\nl2", "n": True}]
    assert w.write_csv(cols, rows) == 'a,n\r\n"say ""hi""",1\r\n"x,y",\r\n"l1\nl2",true\r\n'
    assert w.write_csv(cols, []) == "a,n\r\n"


@pytest.mark.parametrize("lead", ["=", "+", "-", "@", "\t", "\r"])
def test_injection_guard_prefixes_string_cells_only(lead: str) -> None:
    w = _writer()
    text = w.write_csv([w.ExportColumn("s", "string")], [{"s": lead + "x"}])
    body = text.split("\r\n", 1)[1]
    assert body.startswith("'" + lead) or body.startswith("\"'" + lead)  # CR forces quoting
    # a scalar column is never guarded: a negative number stays a number
    assert w.write_csv([w.ExportColumn("n", "scalar")], [{"n": -5}]) == "n\r\n-5\r\n"


def test_guard_runs_before_quoting() -> None:
    w = _writer()
    assert w.write_csv([w.ExportColumn("s", "string")], [{"s": "=a,b"}]) == "s\r\n\"'=a,b\"\r\n"


def test_bom_constant() -> None:
    assert _writer().EXPORT_CSV_BOM is False
    w = _writer(csv_bom=True)
    assert w.write_csv([w.ExportColumn("a", "scalar")], []).startswith("﻿a\r\n")


def test_json_cells_are_compact_json() -> None:
    w = _writer()
    assert w.wire_text(["a", 1]) == '["a",1]'


def test_xml_escaping_and_empty_vs_nil() -> None:
    cols = lambda w: [w.ExportColumn("a", "string")]  # noqa: E731
    rows = [{"a": "<&>\r\n"}, {"a": None}]
    empty = _writer()
    assert empty.write_xml("R", cols(empty), rows) == (
        "<R><row><a>&lt;&amp;&gt;&#13;&#10;</a></row><row><a/></row></R>"
    )
    nil = _writer(xml_nulls="nil")
    out = nil.write_xml("R", cols(nil), rows)
    assert out.startswith('<R xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
    assert '<a xsi:nil="true"/>' in out
    ET.fromstring(out)
    assert nil.write_xml("R", cols(nil), []) == '<R xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>'
    assert empty.write_xml("R", cols(empty), []) == "<R/>"


def test_xml_drops_characters_xml_cannot_carry() -> None:
    w = _writer()
    ET.fromstring(w.write_xml("R", [w.ExportColumn("a", "string")], [{"a": "a\x00b"}]))


def test_options_are_validated() -> None:
    with pytest.raises(ValueError):
        report_export_generator(xml_nulls="null")
    with pytest.raises(ValueError):
        report_export_generator(max_rows=0)
    assert ReportExportGenerator().xml_nulls == "empty"  # Python's own null form
    assert ReportExportGenerator().max_rows == 100_000


# --- request helper --------------------------------------------------------------------


def test_request_helper() -> None:
    assert rt.requested_format({}) is None
    assert rt.requested_format({"format": ""}) == ""
    assert rt.invalid_format_envelope() == {"error": "invalid_format", "expected": ["csv", "json", "xml"]}
    assert rt.export_too_large_envelope(60) == {"error": "export_too_large", "maxRows": 60}
    assert rt.export_with_count_envelope()["error"] == "export_with_count"
    assert rt.content_disposition("export_cells", "csv") == 'attachment; filename="export_cells.csv"'
    assert [rt.is_truthy_flag(v) for v in ("1", "true", "TRUE", "0", "", None)] == [
        True, True, True, False, False, False,
    ]


# --- generator + router wiring ---------------------------------------------------------


def _gen(names: set[str], **export_opts) -> dict[str, str]:
    tmp = Path(tempfile.mkdtemp(prefix="report-export-"))
    shutil.copy(_CORPUS / "meta.json", tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    assert not result.errors
    gens = [
        router_generator(60) if e.name == "routes"
        else report_export_generator(**export_opts) if e.name == "report-export"
        else e.factory(GeneratorBuildContext(template_root=str(tmp)))
        for e in list_generators()
        if e.name in names
    ]
    out = tmp / "out"
    run_gen(GenConfig(out_dir=str(out)), result.root, generators=gens)
    return {p.name: p.read_text(encoding="utf-8") for p in out.rglob("*.py")}


_BASE = {"entity", "filter-allowlist", "routes"}


def test_unwired_routes_carry_no_export_branch() -> None:
    files = _gen(_BASE)
    assert "report_export_writer.py" not in files
    assert not any(f.endswith("_export.py") for f in files)
    router = files["invoice_status_totals_router.py"]
    assert "report_export" not in router and "jsonable_encoder" not in router
    assert "format" not in router.replace("information", "")


def test_wired_emits_one_writer_and_one_module_per_served_report() -> None:
    files = _gen(_BASE | {"report-export"}, max_rows=60, xml_nulls="nil")
    assert "EXPORT_MAX_ROWS = 60" in files["report_export_writer.py"]
    assert 'EXPORT_XML_NULLS = "nil"' in files["report_export_writer.py"]
    exports = sorted(f for f in files if f.endswith("_export.py"))
    assert "export_cells_export.py" in exports and "invoice_days_export.py" not in exports
    cols = files["invoice_status_totals_export.py"]
    assert cols.index('"status"') < cols.index('"invoices"') < cols.index('"totalCents"')
    router = files["invoice_status_totals_router.py"]
    assert "report_export_writer import EXPORT_MAX_ROWS" in router
    assert "export_too_large_envelope" in router and "report_too_large" in router
    # the entity (writable) routers are untouched by export
    assert "format" not in files.get("invoice_router.py", "")
