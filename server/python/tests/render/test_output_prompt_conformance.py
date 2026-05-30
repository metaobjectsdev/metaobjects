"""Cross-language output-prompt-conformance corpus runner — FR-010 prompt gate.

Each case dir under ``fixtures/output-prompt-conformance/`` holds:

- ``spec.json``                  the output-format descriptor (format / rootName /
  roundTrip? / fields[{name, kind, required, array?, example?, instruction?,
  enumValues?, enumDoc?, nested?}]).
- ``expected.guide.txt`` / ``expected.inline.txt`` / ``expected.exampleOnly.txt``
  byte-exact reference text (TS-produced; C# + Java reproduce it byte-for-byte).

The runner reproduces those bytes EXACTLY using Python's ``render_output_format``,
proving cross-port byte-identity. The corpus is the oracle — do not weaken
assertions or edit the fixtures. 1:1 port of ``output-prompt-conformance.test.ts``.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.render import (
    OutputFormatSpec,
    PromptField,
    PromptOverrides,
    PromptStyle,
    render_output_format,
)
from metaobjects.render.recover import (
    FieldKind,
    FieldRecovery,
    FieldSpec,
    Format,
    RecoverSchema,
    recover,
)


def _find_corpus() -> Path:
    p = Path(__file__).resolve()
    while p != p.parent:
        candidate = p / "fixtures" / "output-prompt-conformance"
        if candidate.is_dir():
            return candidate
        p = p.parent
    raise RuntimeError(
        "fixtures/output-prompt-conformance not found walking up from tests/"
    )


_CORPUS = _find_corpus()

# Count guard: a port silently skipping cases must fail. Bump when adding cases.
EXPECTED_CASE_COUNT = 10

_FORMATS = {"json": Format.JSON, "xml": Format.XML}
_KINDS = {
    "STRING": FieldKind.STRING,
    "INT": FieldKind.INT,
    "LONG": FieldKind.LONG,
    "DOUBLE": FieldKind.DOUBLE,
    "BOOLEAN": FieldKind.BOOLEAN,
    "ENUM": FieldKind.ENUM,
    "OBJECT": FieldKind.OBJECT,
}

_STYLES: list[tuple[str, PromptStyle]] = [
    ("guide", PromptStyle.GUIDE),
    ("inline", PromptStyle.INLINE),
    ("exampleOnly", PromptStyle.EXAMPLE_ONLY),
]


def _cases() -> list[str]:
    return sorted(
        d.name for d in _CORPUS.iterdir() if (d / "spec.json").is_file()
    )


def _str_or_none(v: object) -> str | None:
    return None if v is None else str(v)


def _build_output_spec(c: dict[str, object]) -> OutputFormatSpec:
    fmt = _FORMATS[str(c["format"])]
    root_name = str(c["rootName"])
    fields_raw = c["fields"]
    assert isinstance(fields_raw, list)
    fields: list[PromptField] = []
    for f in fields_raw:
        assert isinstance(f, dict)
        enum_values_raw = f.get("enumValues")
        enum_values = (
            [str(v) for v in enum_values_raw]
            if isinstance(enum_values_raw, list)
            else None
        )
        enum_doc_raw = f.get("enumDoc")
        enum_doc = (
            {str(k): str(v) for k, v in enum_doc_raw.items()}
            if isinstance(enum_doc_raw, dict)
            else None
        )
        nested_raw = f.get("nested")
        nested = (
            _build_output_spec(nested_raw) if isinstance(nested_raw, dict) else None
        )
        fields.append(
            PromptField(
                name=str(f["name"]),
                kind=_KINDS[str(f["kind"])],
                required=bool(f["required"]),
                array=bool(f.get("array", False)),
                enum_values=enum_values,
                enum_doc=enum_doc,
                example=_str_or_none(f.get("example")),
                instruction=_str_or_none(f.get("instruction")),
                nested=nested,
            )
        )
    # style here is a placeholder; each render overrides it per style.
    return OutputFormatSpec(
        format=fmt, root_name=root_name, style=PromptStyle.GUIDE, fields=fields
    )


def _build_recover_schema(c: dict[str, object]) -> RecoverSchema:
    fmt = _FORMATS[str(c["format"])]
    root_name = str(c["rootName"])
    fields_raw = c["fields"]
    assert isinstance(fields_raw, list)
    fields: list[FieldSpec] = []
    for f in fields_raw:
        assert isinstance(f, dict)
        name = str(f["name"])
        kind_token = str(f["kind"])
        required = bool(f["required"])
        if kind_token == "ENUM":
            enum_values_raw = f.get("enumValues")
            enum_values = (
                [str(v) for v in enum_values_raw]
                if isinstance(enum_values_raw, list)
                else None
            )
            fields.append(FieldSpec.enum_field(name, required, enum_values, {}))
        elif kind_token == "OBJECT":
            nested_raw = f.get("nested")
            nested = (
                _build_recover_schema(nested_raw)
                if isinstance(nested_raw, dict)
                else None
            )
            fields.append(
                FieldSpec.object_(name, required, bool(f.get("array", False)), nested)
            )
        else:
            fields.append(FieldSpec.scalar(name, _KINDS[kind_token], required))
    return RecoverSchema(fmt, root_name, fields)


def _read_text(path: Path) -> str:
    # Byte-exact: decode bytes directly so no newline translation occurs.
    return path.read_bytes().decode("utf-8")


def test_discovers_all_output_prompt_conformance_cases() -> None:
    """Count guard mirrors the TS / C# / Java runners — a deleted/added fixture must
    fail CI rather than silently change coverage."""
    assert len(_cases()) == EXPECTED_CASE_COUNT


@pytest.mark.parametrize("case_name", _cases())
def test_renders_corpus_byte_exact(case_name: str) -> None:
    case_dir = _CORPUS / case_name
    spec_dict = json.loads((case_dir / "spec.json").read_text())
    ofs = _build_output_spec(spec_dict)

    for key, style in _STYLES:
        overrides = PromptOverrides(style=style)
        actual = render_output_format(ofs, overrides)
        expected = _read_text(case_dir / f"expected.{key}.txt")
        assert actual == expected, f"{case_name}/{key}: byte drift"
        # determinism: identical across runs
        assert render_output_format(ofs, overrides) == actual, (
            f"{case_name}/{key}: non-deterministic render"
        )

    if spec_dict.get("roundTrip"):
        example_fragment = _read_text(case_dir / "expected.exampleOnly.txt")
        outcome = recover(example_fragment, _build_recover_schema(spec_dict))
        # Skew guard: a field the renderer emitted must read back cleanly. NO state
        # may be MALFORMED or LOST_* (robust to DEFAULTED and to how a nested
        # OBJECT-container path classifies); any such state means the renderer
        # emitted an example the recover parser cannot read.
        bad = {
            FieldRecovery.MALFORMED,
            FieldRecovery.LOST_REQUIRED,
            FieldRecovery.LOST_OPTIONAL,
        }
        for field_path, state in outcome.report.states().items():
            assert state not in bad, (
                f"{case_name}: field {field_path!r} round-tripped as {state}"
            )
