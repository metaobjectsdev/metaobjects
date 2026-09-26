"""Public entry point. Runs the extract pipeline; never throws."""
from __future__ import annotations

from metaobjects.render.extract import coerce as _coerce
from metaobjects.render.extract import locate as _locate
from metaobjects.render.extract import strip as _strip
from metaobjects.render.extract.coerce import MALFORMED
from metaobjects.render.extract.json_forgiving_reader import (
    NULL_LITERAL,
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

    # XML rootless (opts.rootless): the payload's fields ARE the top-level elements — there
    # is no enclosing root to locate — so parse the whole stripped text's top-level elements
    # directly. Otherwise locate the <rootName> span as before. JSON is unaffected. Mirrors
    # Java Extract.extract.
    span: str | None
    raw: dict[str, object]
    if schema.format == Format.JSON:
        span = _select_json(text, stripped, schema.fields, ci)
        raw = {} if span is None else JsonForgivingReader().read(span)
    elif o.rootless:
        span = None if stripped == "" else stripped
        raw = {} if span is None else XmlForgivingReader().read_rootless(stripped, ci)
    else:
        span = _locate.xml(stripped, schema.root_name, ci)
        raw = {} if span is None else XmlForgivingReader().read(span, ci)

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
                    # A default SATISFIES @required, so this field never appears in
                    # lost_required() — which is what the generated guards key on. Record
                    # it separately so "the document did not answer a required field"
                    # stays askable.
                    if f.required:
                        report.mark_defaulted_required(path)
                    continue
            report.set(
                path,
                FieldExtraction.LOST_REQUIRED if f.required else FieldExtraction.LOST_OPTIONAL,
            )
            continue
        if present is TRUNCATED:  # present-but-garbled (empty/cut-off value)
            _mark_malformed(report, path, f)
            continue
        if present is NULL_LITERAL:
            # The JSON null literal is the caller's explicit "no value": leave the field null
            # (do NOT apply @default — an explicit null is a value, not an omission), matching a
            # standard JSON bind. Without this the bare ``null`` token leaks as the string "null".
            report.set(
                path,
                FieldExtraction.LOST_REQUIRED if f.required else FieldExtraction.LOST_OPTIONAL,
            )
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
            if any_malformed:
                _mark_malformed(report, path, f)
            else:
                report.set(path, FieldExtraction.EXTRACTED)
            continue
        if isinstance(present, list):  # a list where a singular value was expected
            _mark_malformed(report, path, f)
            continue
        v = _extract_value(f, present, path, report, o, ci)
        if v is MALFORMED:
            _mark_malformed(report, path, f)
        else:
            data[f.name] = v
            # FR-011: a value reached via @coerceDefault (or @default) is DEFAULTED,
            # not EXTRACTED.
            report.set(path, _classify_coerced(path, report))


def _mark_malformed(report: ExtractionReport, path: str, f: FieldSpec) -> None:
    """Classify a present-but-unusable field MALFORMED. A ``@required`` one is also recorded
    in ``malformed_required()`` — its value is missing from data just as a lost field's is, so
    the strict gate must fail on it (the extract-conformance corpus pins the set in every port)."""
    report.set(path, FieldExtraction.MALFORMED)
    if f.required:
        report.mark_malformed_required(path)


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
    if present is NULL_LITERAL:
        # A JSON null array element (e.g. [1, null, 3]) carries no value → drop it as malformed
        # rather than letting the sentinel stringify.
        return MALFORMED
    if f.kind == FieldKind.OBJECT:
        if f.nested is not None and isinstance(present, dict):
            nested_data: dict[str, object] = {}
            _extract(f.nested.fields, present, path, nested_data, report, o, ci)
            return nested_data
        return MALFORMED  # object expected but scalar/non-map present
    # A text element that also carried XML attributes is represented by XmlForgivingReader
    # as a dict with the body under TEXT_KEY. A scalar field reads that text (attributes
    # ignored for scalars — preserving pre-attribute-support behaviour).
    if isinstance(present, dict):
        # An element with no text of its own (only child elements) is not a scalar value.
        # Never stringify the dict: that delivered "{'child': ...}" as the field's text.
        if TEXT_KEY not in present:
            return MALFORMED
        present = present[TEXT_KEY]
    raw_str = present if isinstance(present, str) else str(present)
    return _coerce.value(raw_str, f, o, path, report)


def _select_json(
    text: str | None, stripped: str, fields: list[FieldSpec], ci: bool
) -> str | None:
    """Pick the JSON object that answers the schema. Fenced blocks are searched first, then
    the whole reply, and the first object carrying at least one declared field wins, so a
    draft object, an echoed format example or a brace in prose no longer shadows the real
    answer (#363). A fenced object with none of the declared fields falls through the same
    way. When nothing carries a declared field, the first-object rule (``locate.json``)
    decides."""
    for region in [*_strip.fenced_bodies(text), stripped]:
        for candidate in _locate.json_candidates(region):
            parsed = JsonForgivingReader().read(candidate)
            if any(_carries(parsed, f.name, ci) for f in fields):
                return candidate
    return _locate.json(stripped)


def _carries(raw: dict[str, object], name: str, ci: bool) -> bool:
    if name in raw:
        return True
    return ci and any(k.lower() == name.lower() for k in raw)


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
