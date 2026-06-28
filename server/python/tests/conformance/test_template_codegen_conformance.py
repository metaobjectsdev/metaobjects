"""Cross-port conformance gate (Python): runs spec.json over the shared
fixtures/template-codegen-conformance/ corpus and asserts byte-identical output
to expected/ (the TS-produced oracle). The render engine is already byte-equal
across ports, so any diff here is a Python data-dict or scope/pattern bug — never
a reason to edit expected/.
"""

import json
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.template_codegen.template_spec import (
    parse_template_spec,
    template_spec_to_generators,
)
from metaobjects.render.filesystem_provider import FilesystemProvider

CORPUS = Path(__file__).resolve().parents[4] / "fixtures" / "template-codegen-conformance"


def _rel_files(root: Path) -> list[str]:
    return sorted(
        str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()
    )


def test_corpus_matches_expected_byte_for_byte(tmp_path: Path) -> None:
    spec = parse_template_spec(json.loads((CORPUS / "spec.json").read_text(encoding="utf-8")))
    root = MetaDataLoader.from_directory(str(CORPUS / "metadata")).root
    objects = [c for c in root.children() if isinstance(c, MetaObject)]
    provider = FilesystemProvider(str(CORPUS / "templates"))

    ctx = GenContext(
        entities=objects, loaded_root=root, matches=lambda e: True,
        config=None, warn=lambda m: None,
    )
    out = tmp_path / "out"
    for gen in template_spec_to_generators(spec, provider):
        for f in gen.generate(ctx):
            target = out / f.path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f.content, encoding="utf-8")

    expected = CORPUS / "expected"
    assert _rel_files(out) == _rel_files(expected)
    for rel in _rel_files(expected):
        assert (out / rel).read_text(encoding="utf-8") == (expected / rel).read_text(
            encoding="utf-8"
        ), f"byte mismatch in {rel}"
