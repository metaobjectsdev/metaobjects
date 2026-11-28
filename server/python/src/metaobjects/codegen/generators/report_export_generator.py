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
from metaobjects.codegen.constants import generated_header_lines
from metaobjects.codegen.writer import PyWriter, call, group, str_lit
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.import_path import ModuleScope
from metaobjects.codegen.instance_artifacts import is_served_report
from metaobjects.codegen.name_claims import claimed_module_path
from metaobjects.codegen.value_objects import pkg_of
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
        """The shared module: the options as constants, then the CSV and XML writers, which
        are fixed runtime code written as snippets."""
        w = PyWriter()
        w.header(*generated_header_lines("report-export", "metaobjects::report-export"))
        w.module_doc(
            "GENERATED shared writers for report export: CSV and XML. Standard library only.",
            "",
            "Rows are lists of dicts in wire form (what the JSON export writes). A column is",
            '``ExportColumn(name, kind)``: ``"string"`` cells get the formula-injection guard in CSV,',
            '``"scalar"`` cells never do, ``"json"`` cells (arrays, maps, objects) are written as '
            "compact JSON.",
        )
        w.use_future()
        w.use_module("json")
        w.use_module("re")
        for name in ("Iterable", "Mapping", "Sequence"):
            w.use(name, "collections.abc")
        w.use("dataclass", "dataclasses")
        w.use("Any", "typing")
        w.use("escape", "xml.sax.saxutils")
        w.use("quoteattr", "xml.sax.saxutils")
        w.line("#: The export cap: more rows than this is ``400 export_too_large``, never a truncated body.")
        w.line(f"EXPORT_MAX_ROWS = {self.max_rows}")
        w.line("#: Write a UTF-8 byte order mark before the CSV header row.")
        w.line(f"EXPORT_CSV_BOM = {bool(self.csv_bom)!r}")
        w.line('#: How a null is written in XML: ``"empty"`` (an empty element) or ``"nil"`` (``xsi:nil="true"``).')
        w.line(f"EXPORT_XML_NULLS = {str_lit(self.xml_nulls)}")
        w.blank()
        w.line('XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance"')
        w.blank()
        w.line("#: A string cell starting with one of these is prefixed with an apostrophe.")
        w.line('_INJECTION_START = ("=", "+", "-", "@", "\\t", "\\r")')
        w.line("#: Characters XML 1.0 cannot carry at all.")
        w.line('_XML_ILLEGAL = re.compile("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\ufffe\\uffff]")')
        w.gap()
        w.text(
            r'''
            @dataclass(frozen=True)
            class ExportColumn:
                name: str
                kind: str  # "string" | "scalar" | "json"
            '''
        )
        w.gap()
        w.text(
            r'''
            def wire_text(value: Any) -> str:
                """The text of one wire-form value: null is empty, a boolean is true/false."""
                if value is None:
                    return ""
                if isinstance(value, bool):
                    return "true" if value else "false"
                if isinstance(value, (dict, list)):
                    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
                return str(value)
            '''
        )
        w.gap()
        w.text(
            r'''
            def csv_cell(text: str, guard: bool) -> str:
                """One CSV field: the injection guard (string cells only), then quoting."""
                if guard and text.startswith(_INJECTION_START):
                    text = "'" + text
                if any(c in text for c in '",\r\n'):
                    return '"' + text.replace('"', '""') + '"'
                return text
            '''
        )
        w.gap()
        w.text(
            r'''
            def write_csv(columns: Sequence[ExportColumn], rows: Iterable[Mapping[str, Any]]) -> str:
                """RFC 4180: a header row of the column names, CRLF after every record including the last."""
                out = ["\ufeff" if EXPORT_CSV_BOM else ""]
                out.append(",".join(csv_cell(c.name, False) for c in columns) + "\r\n")
                for row in rows:
                    out.append(
                        ",".join(csv_cell(wire_text(row.get(c.name)), c.kind == "string") for c in columns)
                        + "\r\n"
                    )
                return "".join(out)
            '''
        )
        w.gap()
        w.text(
            r'''
            def xml_text(text: str) -> str:
                """Element text: illegal characters replaced, & < > escaped, CR and LF as references."""
                return escape(_XML_ILLEGAL.sub("\ufffd", text), {"\r": "&#13;", "\n": "&#10;"})
            '''
        )
        w.gap()
        w.text(
            r'''
            def write_xml(root: str, columns: Sequence[ExportColumn], rows: Iterable[Mapping[str, Any]]) -> str:
                """``<Root><row><field>value</field>...</row>...</Root>``: no declaration, no indentation."""
                nil = EXPORT_XML_NULLS == "nil"
                out = [f"<{root}" + (f" xmlns:xsi={quoteattr(XSI_NAMESPACE)}" if nil else "")]
                body: list[str] = []
                for row in rows:
                    body.append("<row>")
                    for c in columns:
                        value = row.get(c.name)
                        if value is None:
                            body.append(f'<{c.name} xsi:nil="true"/>' if nil else f"<{c.name}/>")
                        else:
                            body.append(f"<{c.name}>{xml_text(wire_text(value))}</{c.name}>")
                    body.append("</row>")
                if body:
                    out.append(">" + "".join(body) + f"</{root}>")
                else:
                    out.append("/>")
                return "".join(out)
            '''
        )
        return w.to_string()

    def render_report(self, report: MetaObject, scope: ModuleScope = ModuleScope()) -> str:
        """The export module of one served report: its columns in derived-field order."""
        w = PyWriter()
        w.header(*generated_header_lines(report.name, report.resolution_key()))
        w.module_doc(f"GENERATED — CSV and XML export of the {report.name} report.")
        w.use_future()
        w.use("Iterable", "collections.abc")
        w.use("Mapping", "collections.abc")
        w.use("Any", "typing")
        for name in ("ExportColumn", "write_csv", "write_xml"):
            w.use(name, scope.root(WRITER_MODULE))
        w.line(f"EXPORT_ROOT = {str_lit(report.name)}")
        cols = [
            call("ExportColumn", [str_lit(f.name), str_lit(_column_kind(f))])
            for f in report.fields()
            if not is_credential_field(f)  # #484: an export names no credential column
        ]
        w.line("EXPORT_COLUMNS = ", group("[", cols, "]"))
        w.gap()
        w.open("def export_csv(rows: Iterable[Mapping[str, Any]]) -> str:")
        w.line("return write_csv(EXPORT_COLUMNS, rows)")
        w.dedent().gap()
        w.open("def export_xml(rows: Iterable[Mapping[str, Any]]) -> str:")
        w.line("return write_xml(EXPORT_ROOT, EXPORT_COLUMNS, rows)")
        return w.to_string()

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        reports = [e for e in ctx.entities if ctx.matches(e) and is_served_report(e)]
        if not reports:
            return []
        files = [
            EmittedFile(
                path=f"{WRITER_MODULE}.py",
                content=self.render_writer(),
            )
        ]
        for report in reports:
            if not ctx.is_selected(report):
                continue  # the writers module is shared; a report's own module is per-entity
            files.append(
                EmittedFile(
                    path=claimed_module_path(
                        ctx.claims, ctx.config, pkg_of(report), f"{_snake_case(report.name)}_export",
                        report.resolution_key(),
                    ),
                    content=self.render_report(
                        report, ModuleScope(ctx.config.output_layout, pkg_of(report))
                    ),
                    source_node=report.resolution_key(),
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
