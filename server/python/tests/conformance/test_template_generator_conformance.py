"""Cross-port byte-equivalence harness for the Python template_generator().

Mirrors the TS reference adapter:
server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts

Fixture format: fixtures/render-conformance/template-generator/README.md
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.template_generator import template_generator
from metaobjects.render import escapers
from metaobjects.render.verify import InMemoryProvider
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.shared.base_types import (
    TYPE_METADATA, TYPE_OBJECT, TYPE_FIELD, SUBTYPE_ROOT,
)
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY


def _find_corpus() -> Path:
    p = Path(__file__).resolve()
    while p != p.parent:
        candidate = p / "fixtures" / "render-conformance" / "template-generator"
        if candidate.is_dir():
            return candidate
        p = p.parent
    raise RuntimeError("fixtures/render-conformance/template-generator not found")


_CORPUS = _find_corpus()

_FIELD_TYPE_MAP = {
    "string": fc.FIELD_SUBTYPE_STRING,
    "long": fc.FIELD_SUBTYPE_LONG,
    "int": fc.FIELD_SUBTYPE_INT,
    "double": fc.FIELD_SUBTYPE_DOUBLE,
    "boolean": fc.FIELD_SUBTYPE_BOOLEAN,
    "date": fc.FIELD_SUBTYPE_DATE,
}

_FORMAT_MAP = {
    "text": escapers.FORMAT_TEXT,
    "html": escapers.FORMAT_HTML,
    "markdown": escapers.FORMAT_MARKDOWN,
    "xml": escapers.FORMAT_XML,
    "csv": escapers.FORMAT_CSV,
    "json": escapers.FORMAT_JSON,
}


def _build_root_from_meta(meta: dict[str, Any]) -> MetaRoot:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "conformance")
    for e in meta["entities"]:
        obj = MetaObject(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, e["name"])
        for f in e["fields"]:
            subtype = _FIELD_TYPE_MAP.get(f["type"])
            if subtype is None:
                raise ValueError(f"Unknown field type {f['type']!r}")
            obj.add_child(MetaField(TYPE_FIELD, subtype, f["name"]))
        root.add_child(obj)
    return root


def _fixtures() -> list[Path]:
    return sorted(
        p for p in _CORPUS.iterdir()
        if p.is_dir() and p.name.startswith("fixture-")
    )


def _collect_expected(fixture_dir: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    root = fixture_dir / "expected"
    if not root.is_dir():
        return out
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out[str(path.relative_to(root))] = path.read_text(encoding="utf-8")
    return out


@pytest.mark.parametrize("fixture_dir", _fixtures(), ids=lambda p: p.name)
def test_template_generator_conformance(fixture_dir: Path) -> None:
    meta = json.loads((fixture_dir / "meta.json").read_text(encoding="utf-8"))
    template_body = (fixture_dir / "template.mustache").read_text(encoding="utf-8")
    walk_entries = json.loads((fixture_dir / "walk.json").read_text(encoding="utf-8"))
    expected = _collect_expected(fixture_dir)

    root = _build_root_from_meta(meta)
    by_name = {e.name for e in root.children() if isinstance(e, MetaObject)}
    for w in walk_entries:
        if w.get("entity") is not None and w["entity"] not in by_name:
            raise AssertionError(f"walk.json references unknown entity {w['entity']!r}")

    provider = InMemoryProvider({"conformance/template": template_body})
    gen = template_generator(
        name=fixture_dir.name,
        template="conformance/template",
        provider=provider,
        format=_FORMAT_MAP[meta["format"]],
        walk=lambda r: [
            {"data": w["data"], "output_path": w["outputPath"]} for w in walk_entries
        ],
    )
    ctx = GenContext(
        entities=[c for c in root.children() if isinstance(c, MetaObject)],
        loaded_root=root,
        matches=lambda e: True,
        config=GenConfig(out_dir="/tmp"),
        warn=lambda m: None,
    )
    files = gen.generate(ctx)

    emitted = {f.path: f.content for f in files}
    assert sorted(emitted.keys()) == sorted(w["outputPath"] for w in walk_entries)

    for w in walk_entries:
        path = w["outputPath"]
        assert path in expected, f"expected/{path} missing from fixture {fixture_dir.name}"
        assert emitted[path] == expected[path], (
            f"byte-equivalence failure in {fixture_dir.name}: {path}\n"
            f"--- expected ---\n{expected[path]!r}\n--- actual ---\n{emitted[path]!r}"
        )
