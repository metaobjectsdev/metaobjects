"""Public entry point. Runs the extract pipeline; never throws."""
from __future__ import annotations

from metaobjects.render.extract import coerce as _coerce
from metaobjects.render.extract import locate as _locate
from metaobjects.render.extract import strip as _strip
from metaobjects.render.extract.coerce import MALFORMED
from metaobjects.render.extract.json_forgiving_reader import (
    TRUNCATED,
    JsonForgivingReader,
)
from metaobjects.render.extract.types import (
    Coercion,
    FieldKind,
    FieldExtraction,
    FieldSpec,
    Format,
    ExtractOptions,
    ExtractionOutcome,
    ExtractSchema,
    ExtractionReport,
    Tolerance,
)
from metaobjects.render.extract.xml_forgiving_reader import TEXT_KEY, XmlForgivingReader


def extract(
    text: str | None,
    schema: ExtractSchema,
    opts: ExtractOptions | None = None,
) -> ExtractionOutcome:
    """Extract structured data from dirty ``text`` per ``schema``. Never raises."""
    o = ExtractOptions.defaults() if opts is None else opts
    report = ExtractionReport()
    data: dict[str, object] = {}

    stripped = _strip.strip(text)
    ci = o.tolerance != Tolerance.STRICT

    if schema.format == Format.JSON:
        span = _locate.json(stripped)
    else:
        span = _locate.xml(stripped, schema.root_name, ci)

    raw: dict[str, object]
    if span is None:
        raw = {}
    elif schema.format == Format.JSON:
        raw = JsonForgivingReader().read(span)
    else:
        raw = XmlForgivingReader().read(span, ci)

    if not raw and (stripped == "" or span is None):
        report.mark_empty()

    _extract(schema.fields, raw, "", data, report, o, ci)
    return ExtractionOutcome(data=data, report=report)


def _extract(
    fields: list[FieldSpec],
    raw: dict[str, object],
    prefix: str,
    data: dict[str, object],
    report: ExtractionReport,
    o: ExtractOptions,
    ci: bool,
) -> None:
    for f in fields:
        path = f.name if prefix == "" else prefix + "." + f.name
        # A @xmlText field reads the element's text body (carried under the #text sentinel when
        # the element also has attributes), not a same-named child element.
        present = raw.get(TEXT_KEY) if f.text_content else _lookup(raw, f.name, ci)
        if present is None:
            # FR-011 / Phase B: an absent field with a declared @default fills the
            # value → DEFAULTED (which satisfies a @required field). Generalized to
            # all field kinds: an enum default is its member string verbatim; a
            # non-enum default is coerced to the field's kind via the PURE
            # scalar_coerce (so @default "0" on field.int yields integer 0). A
            # non-coercible non-enum default is treated as no default.
            if f.default_value is not None:
                coerced = (
                    f.default_value
                    if f.kind == FieldKind.ENUM
                    else _coerce.scalar_coerce(f.default_value, f)
                )
                if coerced is not MALFORMED:
                    data[f.name] = coerced
                    report.add_coercion(Coercion(path, "", f.default_value, "default"))
                    report.set(path, FieldExtraction.DEFAULTED)
                    continue
            report.set(
                path,
                FieldExtraction.LOST_REQUIRED if f.required else FieldExtraction.LOST_OPTIONAL,
            )
            continue
        if present is TRUNCATED:  # present-but-garbled (empty/cut-off value)
            report.set(path, FieldExtraction.MALFORMED)
            continue
        if f.array:
            # A single non-list value is treated as a one-element array (e.g. a single
            # repeated-XML tag). Each element is coerced/recursed independently.
            elements = present if isinstance(present, list) else [present]
            out: list[object] = []
            any_malformed = False
            # Phase B (array-of-enum): an enum element flows through the SAME enum
            # coercion pipeline a scalar enum uses (_extract_value → coerce.value →
            # _coerce_enum) and is CLASSIFIED per element by indexed path (tags[0],
            # tags[1], …) exactly as a scalar enum: EXTRACTED / DEFAULTED (via
            # @coerceDefault) / MALFORMED. Non-enum scalar arrays keep their existing
            # behavior (coerced element list, no per-element states).
            enum_elements = f.kind == FieldKind.ENUM
            for idx, el in enumerate(elements):
                elem_path = f"{path}[{idx}]"
                v = _extract_value(f, el, elem_path, report, o, ci)
                if v is MALFORMED:
                    any_malformed = True
                    if enum_elements:
                        report.set(elem_path, FieldExtraction.MALFORMED)
                else:
                    out.append(v)
                    if enum_elements:
                        report.set(elem_path, _classify_coerced(elem_path, report))
            # Cross-port contract: a MALFORMED array still places its successfully-coerced
            # elements into data (partial extraction), UNLIKE a MALFORMED scalar which is
            # absent from data.
            data[f.name] = out
            report.set(
                path, FieldExtraction.MALFORMED if any_malformed else FieldExtraction.EXTRACTED
            )
            continue
        if isinstance(present, list):  # a list where a singular value was expected
            report.set(path, FieldExtraction.MALFORMED)
            continue
        v = _extract_value(f, present, path, report, o, ci)
        if v is MALFORMED:
            report.set(path, FieldExtraction.MALFORMED)
        else:
            data[f.name] = v
            # FR-011: a value reached via @coerceDefault (or @default) is DEFAULTED,
            # not EXTRACTED.
            report.set(path, _classify_coerced(path, report))


def _classify_coerced(path: str, report: ExtractionReport) -> FieldExtraction:
    """FR-011: classify a successfully-coerced field. DEFAULTED when its terminal
    (last-logged) coercion for this path is a default-class fallback
    (``coerceDefault`` / ``default``); EXTRACTED otherwise. Nested objects (which log
    no coercion of their own) classify as EXTRACTED. Mirrors the TS/C#/Java classify."""
    terminal_kind: str | None = None
    for c in report.coercions():
        if c.field_path == path:
            terminal_kind = c.kind
    return (
        FieldExtraction.DEFAULTED
        if terminal_kind in ("coerceDefault", "default")
        else FieldExtraction.EXTRACTED
    )


def _extract_value(
    f: FieldSpec,
    present: object,
    path: str,
    report: ExtractionReport,
    o: ExtractOptions,
    ci: bool,
) -> object:
    """Coerce one (non-array) element: nested recursion or scalar coercion."""
    if f.kind == FieldKind.OBJECT:
        if f.nested is not None and isinstance(present, dict):
            nested_data: dict[str, object] = {}
            _extract(f.nested.fields, present, path, nested_data, report, o, ci)
            return nested_data
        return MALFORMED  # object expected but scalar/non-map present
    # A text element that also carried XML attributes is represented by XmlForgivingReader
    # as a dict with the body under TEXT_KEY. A scalar field reads that text (attributes
    # ignored for scalars — preserving pre-attribute-support behaviour).
    if isinstance(present, dict) and TEXT_KEY in present:
        present = present[TEXT_KEY]
    raw_str = present if isinstance(present, str) else str(present)
    return _coerce.value(raw_str, f, o, path, report)


def _lookup(raw: dict[str, object], name: str, ci: bool) -> object | None:
    """Case-folding lookup honoring tolerance."""
    if name in raw:
        return raw[name]
    if ci:
        lower = name.lower()
        for k, v in raw.items():
            if k.lower() == lower:
                return v
    return None
