"""Runs ``fixtures/writer-conformance/`` against the Python writer (spec/code-writer.md).

``core`` cases run on :class:`CodeWriter` with the options the case states; ``python`` cases
run on :class:`PyWriter` with its own defaults unless the case overrides them. A case of
another dialect belongs to another port and is skipped.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.codegen.writer import CodeWriter, PyWriter, WriterError, group

CASES = Path(__file__).parents[4] / "fixtures" / "writer-conformance" / "cases"
FILES = sorted(CASES.glob("*.json"))


def _piece(p):
    if isinstance(p, str):
        return p
    if isinstance(p, list):
        return [_piece(x) for x in p]
    lst = p["list"]
    return group(lst["open"], [_piece(i) for i in lst["items"]], lst["close"], bool(lst.get("pad")))


def _options(options: dict | None) -> dict:
    o = options or {}
    out = {}
    if "indent" in o:
        out["indent"] = o["indent"]
    if "width" in o:
        out["width"] = o["width"]
    if "trailingComma" in o:
        out["trailing_comma"] = o["trailingComma"]
    return out


def _run(case: dict) -> str:
    w = CodeWriter(**_options(case.get("options"))) if case["dialect"] == "core" else PyWriter(
        **_options(case.get("options"))
    )
    for op, *args in case["ops"]:
        if op in ("line", "open", "close"):
            getattr(w, op)(*[_piece(a) for a in args])
        elif op == "blank":
            w.blank()
        elif op == "text":
            w.text(args[0])
        else:
            assert isinstance(w, PyWriter), f"op {op} is not a core op"
            if op == "use":
                w.use(args[0], args[1])
            elif op == "useAs":
                w.use(args[0], args[1], as_=args[2])
            elif op == "useModule":
                w.use_module(*args)
            elif op == "useFuture":
                w.use_future(*args)
            elif op == "header":
                w.header(*args)
            elif op == "doc":
                w.doc(*args)
            elif op == "dedent":
                w.dedent()
            elif op == "gap":
                w.gap()
            else:
                raise AssertionError(f"unknown op {op}")
    return w.to_string()


def _cases():
    for f in FILES:
        case = json.loads(f.read_text(encoding="utf-8"))
        if case["dialect"] in ("core", "python"):
            yield pytest.param(case, id=f.stem)


def test_the_corpus_is_present() -> None:
    assert len(FILES) >= 25


@pytest.mark.parametrize("case", _cases())
def test_case(case: dict) -> None:
    if case["dialect"] == "core":
        assert case.get("options") is not None, "a core case states its options"
    if "error" in case:
        with pytest.raises(WriterError) as e:
            _run(case)
        assert e.value.code == case["error"]
        if "errorQuotes" in case:
            assert case["errorQuotes"] in str(e.value)
        return
    lines = case["expected"]
    assert _run(case) == ("" if not lines else "\n".join(lines) + "\n")
