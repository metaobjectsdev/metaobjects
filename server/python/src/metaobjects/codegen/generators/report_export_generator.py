"""``report-export``: CSV and XML writers for a served ``object.report`` (and the ``?format=``
branch of its list route).

Standalone catalog generator (ADR-0034 Amendment 5): never implied by a library. It emits

* ONE shared module per project, ``report_export_writer.py`` (stdlib only): the generator's
  options as constants (``EXPORT_MAX_ROWS``, ``EXPORT_CSV_BOM``, ``EXPORT_XML_NULLS``), the CSV
  writer (RFC 4180 quoting, CRLF after every record, optional BOM, the formula-injection
  guard) and the XML writer (escaping, root and row writing, ``xsi:nil`` or empty nulls);
* per served report, ``<report_snake>_export.py``: the report's columns in derived-field
  order, and ``export_csv`` / ``export_xml`` calling the shared module.

Wiring is by NAME. The router generator emits the ``format`` branch of a report list handler
only when a generator named ``report-export`` is in the run (``GenContext.generators``), so an
owned copy of this generator (same ``name``) wires it too, and a project that wires none gets
routes byte-identical to before. The router imports ``EXPORT_MAX_ROWS`` and the report's
``export_csv`` / ``export_xml`` from the modules emitted here.

Options:

* ``max_rows`` (default 100000): the export cap. The route fetches ``max_rows + 1`` rows and
  answers ``export_too_large`` rather than truncate; an explicit ``limit`` above it is refused
  the same way. With ``?format`` set this cap governs and the list route's ``report_too_large``
  never answers.
* ``xml_nulls`` (``"empty"`` | ``"nil"``, default ``"empty"``): a null cell. ``"empty"`` writes
  an empty element, which is what Python's standard XML serialization does with ``None``
  (``xmltodict.unparse``, ``xml.etree`` after ``text = None``); ``"nil"`` writes
  ``xsi:nil="true"`` and declares ``xmlns:xsi`` on the root. The default is Python's own
  (ADR-0019 Amendment 2); the corpus pins ``"nil"``.
* ``csv_bom`` (default ``False``): emitted as the constant ``EXPORT_CSV_BOM``.

Values reach the writers in wire form: the router passes ``jsonable_encoder(render_wire(rows))``,
i.e. exactly what the JSON export writes, so a decimal is as the project ``wire`` setting spells
it, currency is integer minor units, dates are ISO, booleans are ``true``/``false`` in text and a
null is an empty cell. A column holding an array, map or object is written as compact JSON text.
"""
from __future__ import annotations

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.instance_artifacts import is_served_report
from metaobjects.codegen.type_map import field_is_array
from metaobjects.meta.core.field.credential import is_credential_field
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject

#: The default export cap, the same in every port.
DEFAULT_EXPORT_MAX_ROWS = 100_000

XML_NULLS_EMPTY = "empty"
XML_NULLS_NIL = "nil"
XML_NULLS = (XML_NULLS_EMPTY, XML_NULLS_NIL)

#: The shared module every report export module imports.
WRITER_MODULE = "report_export_writer"

#: Field subtypes whose cell is text a spreadsheet could read as a formula. Numbers, decimals,
#: dates and booleans are never guarded, so a negative number stays a number.
_STRING_SUBTYPES = frozenset({fc.FIELD_SUBTYPE_STRING, fc.FIELD_SUBTYPE_ENUM, fc.FIELD_SUBTYPE_URI})
_JSON_SUBTYPES = frozenset({fc.FIELD_SUBTYPE_MAP, fc.FIELD_SUBTYPE_OBJECT})

_WRITER_SOURCE = '''\
"""GENERATED shared writers for report export: CSV and XML. Standard library only.

Rows are lists of dicts in wire form (what the JSON export writes). A column is
``ExportColumn(name, kind)``: ``"string"`` cells get the formula-injection guard in CSV,
``"scalar"`` cells never do, ``"json"`` cells (arrays, maps, objects) are written as compact JSON.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from xml.sax.saxutils import escape, quoteattr

#: The export cap: more rows than this is ``400 export_too_large``, never a truncated body.
EXPORT_MAX_ROWS = {max_rows}
#: Write a UTF-8 byte order mark before the CSV header row.
EXPORT_CSV_BOM = {csv_bom}
#: How a null is written in XML: ``"empty"`` (an empty element) or ``"nil"`` (``xsi:nil="true"``).
EXPORT_XML_NULLS = "{xml_nulls}"

XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance"

#: A string cell starting with one of these is prefixed with an apostrophe.
_INJECTION_START = ("=", "+", "-", "@", "\\t", "\\r")
#: Characters XML 1.0 cannot carry at all.
_XML_ILLEGAL = re.compile("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\ufffe\\uffff]")


@dataclass(frozen=True)
class ExportColumn:
    name: str
    kind: str  # "string" | "scalar" | "json"


def wire_text(value: Any) -> str:
    """The text of one wire-form value: null is empty, a boolean is true/false."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return str(value)


def csv_cell(text: str, guard: bool) -> str:
    """One CSV field: the injection guard (string cells only), then quoting."""
    if guard and text.startswith(_INJECTION_START):
        text = "'" + text
    if any(c in text for c in '",\\r\\n'):
        return '"' + text.replace('"', '""') + '"'
    return text


def write_csv(columns: Sequence[ExportColumn], rows: Iterable[Mapping[str, Any]]) -> str:
    """RFC 4180: a header row of the column names, CRLF after every record including the last."""
    out = ["\\ufeff" if EXPORT_CSV_BOM else ""]
    out.append(",".join(csv_cell(c.name, False) for c in columns) + "\\r\\n")
    for row in rows:
        out.append(
            ",".join(csv_cell(wire_text(row.get(c.name)), c.kind == "string") for c in columns)
            + "\\r\\n"
        )
    return "".join(out)


def xml_text(text: str) -> str:
    """Element text: illegal characters replaced, & < > escaped, CR and LF as references."""
    return escape(_XML_ILLEGAL.sub("\\ufffd", text), {{"\\r": "&#13;", "\\n": "&#10;"}})


def write_xml(root: str, columns: Sequence[ExportColumn], rows: Iterable[Mapping[str, Any]]) -> str:
    """``<Root><row><field>value</field>...</row>...</Root>``: no declaration, no indentation."""
    nil = EXPORT_XML_NULLS == "nil"
    out = [f"<{{root}}" + (f" xmlns:xsi={{quoteattr(XSI_NAMESPACE)}}" if nil else "")]
    body: list[str] = []
    for row in rows:
        body.append("<row>")
        for c in columns:
            value = row.get(c.name)
            if value is None:
                body.append(f'<{{c.name}} xsi:nil="true"/>' if nil else f"<{{c.name}}/>")
            else:
                body.append(f"<{{c.name}}>{{xml_text(wire_text(value))}}</{{c.name}}>")
        body.append("</row>")
    if body:
        out.append(">" + "".join(body) + f"</{{root}}>")
    else:
        out.append("/>")
    return "".join(out)
'''


def _column_kind(field: MetaField) -> str:
    if field_is_array(field) or field.sub_type in _JSON_SUBTYPES:
        return "json"
    return "string" if field.sub_type in _STRING_SUBTYPES else "scalar"


class ReportExportGenerator:
    """Emits the shared writer module plus one ``<report>_export.py`` per served report."""

    name = "report-export"

    def __init__(
        self,
        max_rows: int = DEFAULT_EXPORT_MAX_ROWS,
        xml_nulls: str = XML_NULLS_EMPTY,
        csv_bom: bool = False,
    ) -> None:
        if max_rows < 1:
            raise ValueError(f"report-export max_rows must be at least 1, got {max_rows}")
        if xml_nulls not in XML_NULLS:
            raise ValueError(f"report-export xml_nulls must be one of {XML_NULLS}, got {xml_nulls!r}")
        self.max_rows = max_rows
        self.xml_nulls = xml_nulls
        self.csv_bom = csv_bom

    def render_writer(self) -> str:
        return _WRITER_SOURCE.format(
            max_rows=self.max_rows, csv_bom=repr(bool(self.csv_bom)), xml_nulls=self.xml_nulls
        )

    def render_report(self, report: MetaObject) -> str:
        """The export module of one served report: its columns in derived-field order."""
        cols = ",\n".join(
            f'    ExportColumn("{f.name}", "{_column_kind(f)}")' for f in report.fields()
            if not is_credential_field(f)  # #484: an export names no credential column
        )
        return (
            generated_header(report.name, report.resolution_key())
            + '"""GENERATED — CSV and XML export of the '
            + f'{report.name} report."""\n'
            + "from __future__ import annotations\n\n"
            + "from collections.abc import Iterable, Mapping\n"
            + "from typing import Any\n\n"
            + f"from .{WRITER_MODULE} import ExportColumn, write_csv, write_xml\n\n"
            + f'EXPORT_ROOT = "{report.name}"\n'
            + f"EXPORT_COLUMNS = (\n{cols},\n)\n\n\n"
            + "def export_csv(rows: Iterable[Mapping[str, Any]]) -> str:\n"
            + "    return write_csv(EXPORT_COLUMNS, rows)\n\n\n"
            + "def export_xml(rows: Iterable[Mapping[str, Any]]) -> str:\n"
            + "    return write_xml(EXPORT_ROOT, EXPORT_COLUMNS, rows)\n"
        )

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        reports = [e for e in ctx.entities if ctx.matches(e) and is_served_report(e)]
        if not reports:
            return []
        files = [
            EmittedFile(
                path=f"{WRITER_MODULE}.py",
                content=ruff_format(
                    generated_header("report-export", "metaobjects::report-export")
                    + self.render_writer()
                ),
            )
        ]
        for report in reports:
            files.append(
                EmittedFile(
                    path=f"{_snake_case(report.name)}_export.py",
                    content=ruff_format(self.render_report(report)),
                )
            )
        return files


def report_export_generator(
    max_rows: int = DEFAULT_EXPORT_MAX_ROWS,
    xml_nulls: str = XML_NULLS_EMPTY,
    csv_bom: bool = False,
) -> Generator:
    """Generator factory for ``report-export``. See the module docstring for the options."""
    return ReportExportGenerator(max_rows, xml_nulls, csv_bom)
