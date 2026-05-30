"""Public entry point. Runs the recover pipeline; never throws."""
from __future__ import annotations

from metaobjects.render.recover import coerce as _coerce
from metaobjects.render.recover import locate as _locate
from metaobjects.render.recover import strip as _strip
from metaobjects.render.recover.coerce import MALFORMED
from metaobjects.render.recover.json_forgiving_reader import (
    TRUNCATED,
    JsonForgivingReader,
)
from metaobjects.render.recover.types import (
    Coercion,
    FieldKind,
    FieldRecovery,
    FieldSpec,
    Format,
    RecoverOptions,
    RecoverOutcome,
    RecoverSchema,
    RecoveryReport,
    Tolerance,
)
from metaobjects.render.recover.xml_forgiving_reader import XmlForgivingReader


def recover(
    text: str | None,
    schema: RecoverSchema,
    opts: RecoverOptions | None = None,
) -> RecoverOutcome:
    """Recover structured data from dirty ``text`` per ``schema``. Never raises."""
    o = RecoverOptions.defaults() if opts is None else opts
    report = RecoveryReport()
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
    return RecoverOutcome(data=data, report=report)


def _extract(
    fields: list[FieldSpec],
    raw: dict[str, object],
    prefix: str,
    data: dict[str, object],
    report: RecoveryReport,
    o: RecoverOptions,
    ci: bool,
) -> None:
    for f in fields:
        path = f.name if prefix == "" else prefix + "." + f.name
        present = _lookup(raw, f.name, ci)
        if present is None:
            # FR-011: an absent enum with a declared @default fills the value →
            # DEFAULTED (which satisfies a @required field).
            if f.kind == FieldKind.ENUM and f.default_value is not None:
                data[f.name] = f.default_value
                report.add_coercion(Coercion(path, "", f.default_value, "default"))
                report.set(path, FieldRecovery.DEFAULTED)
                continue
            report.set(
                path,
                FieldRecovery.LOST_REQUIRED if f.required else FieldRecovery.LOST_OPTIONAL,
            )
            continue
        if present is TRUNCATED:  # present-but-garbled (empty/cut-off value)
            report.set(path, FieldRecovery.MALFORMED)
            continue
        if f.array:
            # A single non-list value is treated as a one-element array (e.g. a single
            # repeated-XML tag). Each element is coerced/recursed independently.
            elements = present if isinstance(present, list) else [present]
            out: list[object] = []
            any_malformed = False
            for idx, el in enumerate(elements):
                v = _extract_value(f, el, f"{path}[{idx}]", report, o, ci)
                if v is MALFORMED:
                    any_malformed = True
                else:
                    out.append(v)
            # Cross-port contract: a MALFORMED array still places its successfully-coerced
            # elements into data (partial recovery), UNLIKE a MALFORMED scalar which is
            # absent from data.
            data[f.name] = out
            report.set(
                path, FieldRecovery.MALFORMED if any_malformed else FieldRecovery.RECOVERED
            )
            continue
        if isinstance(present, list):  # a list where a singular value was expected
            report.set(path, FieldRecovery.MALFORMED)
            continue
        v = _extract_value(f, present, path, report, o, ci)
        if v is MALFORMED:
            report.set(path, FieldRecovery.MALFORMED)
        else:
            data[f.name] = v
            # FR-011: a value reached via @coerceDefault (or @default) is DEFAULTED,
            # not RECOVERED.
            report.set(path, _classify_coerced(path, report))


def _classify_coerced(path: str, report: RecoveryReport) -> FieldRecovery:
    """FR-011: classify a successfully-coerced field. DEFAULTED when its terminal
    (last-logged) coercion for this path is a default-class fallback
    (``coerceDefault`` / ``default``); RECOVERED otherwise. Nested objects (which log
    no coercion of their own) classify as RECOVERED. Mirrors the TS/C#/Java classify."""
    terminal_kind: str | None = None
    for c in report.coercions():
        if c.field_path == path:
            terminal_kind = c.kind
    return (
        FieldRecovery.DEFAULTED
        if terminal_kind in ("coerceDefault", "default")
        else FieldRecovery.RECOVERED
    )


def _extract_value(
    f: FieldSpec,
    present: object,
    path: str,
    report: RecoveryReport,
    o: RecoverOptions,
    ci: bool,
) -> object:
    """Coerce one (non-array) element: nested recursion or scalar coercion."""
    if f.kind == FieldKind.OBJECT:
        if f.nested is not None and isinstance(present, dict):
            nested_data: dict[str, object] = {}
            _extract(f.nested.fields, present, path, nested_data, report, o, ci)
            return nested_data
        return MALFORMED  # object expected but scalar/non-map present
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
