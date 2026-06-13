"""Keystone ACCURACY GATE (Phase 2 Task 2.5): proves the ``PythonApiModelBuilder``'s
documented SDK surface == what the REAL Python (Pydantic / FastAPI) generators emit.

The builder enumerates symbol names via the ``metaobjects.apidocs.naming`` seam (the
SAME seam the real generators delegate to) and gates inclusion via applies-predicates
that reuse each generator's own gate helpers, so by construction documented ==
generated. This test is the cross-check that holds that promise: it runs every real
generator into memory, then greps the generated Python for every documented symbol
(FORWARD) and confirms skip-shapes are not over-documented (INVERSE). The FORWARD
assertions match documented names against the independently generated source — never
against the builder's own strings.

Fixture (a test-local string, NOT the shared cross-port corpus): covers every skip
branch —
  • Author TABLE entity (pk, @required name, optional bio, field.enum status,
    @filterable name) → MODEL / DATA_ACCESS / REST / FILTER / VALIDATION;
  • Address value object referenced by an Author object-field → MODEL only;
  • BaseNode abstract entity → NO unit (no symbols);
  • SummaryOutput json template.output → PAYLOAD / RENDER / PROMPT / OUTPUT_PARSER /
    EXTRACTOR.
"""
from __future__ import annotations

import re
import tempfile
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.apidocs import ApiSymbolKind, PythonApiModelBuilder
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.entity_model import entity_model
from metaobjects.codegen.generators.extractor_generator import extractor_generator
from metaobjects.codegen.generators.filter_allowlist_generator import (
    filter_allowlist_generator,
)
from metaobjects.codegen.generators.output_parser_generator import (
    output_parser_generator,
)
from metaobjects.codegen.generators.output_prompt_generator import (
    output_prompt_generator,
)
from metaobjects.codegen.generators.payload_vo_generator import payload_vo_generator
from metaobjects.codegen.generators.render_helper_generator import (
    render_helper_generator,
)
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.shared.base_types import TYPE_OBJECT

_MODEL = """
{ "metadata.root": { "package": "blog", "children": [
  { "object.entity": { "name": "BaseNode", "abstract": true, "children": [
    { "field.long": { "name": "id" } }
  ]}},
  { "object.value": { "name": "Address", "children": [
    { "field.string": { "name": "city" } },
    { "field.string": { "name": "zip" } }
  ]}},
  { "object.entity": { "name": "Author", "children": [
    { "source.rdb": { "@table": "authors" } },
    { "field.long":   { "name": "id" } },
    { "field.string": { "name": "name", "@required": true, "@filterable": true } },
    { "field.string": { "name": "bio" } },
    { "field.enum":   { "name": "status", "@required": true, "@values": ["ACTIVE", "RETIRED"] } },
    { "field.object": { "name": "home", "@objectRef": "Address" } },
    { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } }
  ]}},
  { "object.value": { "name": "SummaryPayload", "children": [
    { "field.string": { "name": "summary", "@required": true } }
  ]}},
  { "template.output": {
    "name": "SummaryOutput", "package": "blog", "@payloadRef": "SummaryPayload",
    "@textRef": "blog/summary", "@format": "json", "@promptStyle": "inline"
  }}
]}}
"""


def _load_root():
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "meta.json").write_text(_MODEL, encoding="utf-8")
        r = MetaDataLoader.from_directory(d)
    assert not r.errors, r.errors
    return r.root


def _template_root() -> str:
    """A temp template tree the render-helper build-time drift gate resolves against.
    SummaryOutput → SummaryPayload { summary } — reference ONLY a present field."""
    root = Path(tempfile.mkdtemp(prefix="py-apidocs-tpl-"))
    blog = root / "blog"
    blog.mkdir(parents=True, exist_ok=True)
    (blog / "summary.mustache").write_text("Summary: {{summary}}", encoding="utf-8")
    return str(root)


def _ctx(root) -> GenContext:
    return GenContext(
        entities=[c for c in root.own_children() if c.type == TYPE_OBJECT],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=lambda _m: None,
    )


def _build_and_generate():
    root = _load_root()
    template_root = _template_root()
    model = PythonApiModelBuilder().build(root, "apidocs-fixture")

    ctx = _ctx(root)
    chunks: list[str] = []
    for gen in (
        entity_model(),
        router_generator(),
        filter_allowlist_generator(),
        payload_vo_generator(),
        output_parser_generator(),
        output_prompt_generator(),
        extractor_generator(),
        render_helper_generator(template_root=template_root),
    ):
        for f in gen.generate(ctx):
            chunks.append(f.content)
    return model, "\n".join(chunks)


def _contains_identifier(haystack: str, name: str) -> bool:
    """Word-boundary identifier match: *name* appears as a whole Python identifier."""
    return re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", haystack) is not None


# ---------------------------------------------------------------------------


def test_fixture_documents_the_expected_units() -> None:
    model, _ = _build_and_generate()
    nodes = sorted(u.node for u in model.units)
    # Author + Address + SummaryPayload + SummaryOutput; BaseNode (abstract) absent.
    assert nodes == ["Address", "Author", "SummaryOutput", "SummaryPayload"]


def test_every_documented_type_name_appears_in_generated_python() -> None:
    model, generated = _build_and_generate()
    # The kinds whose symbol name is an emitted Python identifier. REST is excluded
    # (it documents "VERB path", checked separately).
    type_kinds = {
        ApiSymbolKind.MODEL,
        ApiSymbolKind.DATA_ACCESS,
        ApiSymbolKind.VALIDATION,
        ApiSymbolKind.FILTER,
        ApiSymbolKind.PAYLOAD,
        ApiSymbolKind.RENDER,
        ApiSymbolKind.PROMPT,
        ApiSymbolKind.OUTPUT_PARSER,
        ApiSymbolKind.EXTRACTOR,
    }
    checked = 0
    for unit in model.units:
        for sym in unit.symbols:
            if sym.kind not in type_kinds:
                continue
            assert _contains_identifier(generated, sym.name), (
                f"documented {sym.kind} symbol '{sym.name}' (unit {unit.node}) was NOT "
                "found as an identifier in the generated Python — the builder "
                "over-documents or names off-seam."
            )
            checked += 1
    assert checked >= 9, f"expected to cross-check several documented type symbols; saw {checked}"


def test_every_rest_symbol_maps_to_a_real_route_registration() -> None:
    model, generated = _build_and_generate()
    author = next(u for u in model.units if u.node == "Author")
    rest = [s for s in author.symbols if s.kind == ApiSymbolKind.REST]
    # 6 CRUD routes (GET list, GET id, POST, PATCH, PUT, DELETE) on a single-PK
    # writable entity with no M:N.
    assert len(rest) == 6
    for sym in rest:
        verb, path = sym.name.split(" ", 1)
        assert path.startswith("/api/authors")
        remainder = path[len("/api") :]  # "/authors" | "/authors/{id}"
        # The generated router registers @router.<verb>("<remainder-after-prefix>").
        # The APIRouter prefix is "/api/authors", so the registered route path is the
        # remainder AFTER "/api/authors" ("" for list, "/{author_id}" for item).
        suffix = remainder[len("/authors") :]  # "" | "/{id}"
        route = suffix.replace("{id}", "{author_id}")
        decorator = {
            "GET": f'@router.get("{route}")',
            "POST": f'@router.post("{route}"',
            "PATCH": f'@router.patch("{route}")',
            "PUT": f'@router.put("{route}")',
            "DELETE": f'@router.delete("{route}"',
        }[verb]
        assert decorator in generated, (
            f"REST symbol '{sym.name}' has no matching route registration; "
            f"expected: {decorator}"
        )


def test_value_object_is_documented_as_model_only() -> None:
    model, generated = _build_and_generate()
    address = next(u for u in model.units if u.node == "Address")
    assert all(s.kind == ApiSymbolKind.MODEL for s in address.symbols)
    # No AddressRepository / AddressFilterAllowlist generated — even the names absent.
    assert not _contains_identifier(generated, "AddressRepository")
    assert not _contains_identifier(generated, "ADDRESS_FILTER_FIELDS")


def test_abstract_object_is_not_documented() -> None:
    model, _ = _build_and_generate()
    assert not any(u.node == "BaseNode" for u in model.units)


def test_output_template_documents_render_payload_prompt_parser_extractor() -> None:
    model, _ = _build_and_generate()
    summary = next(u for u in model.units if u.node == "SummaryOutput")
    kinds = {s.kind for s in summary.symbols}
    assert kinds == {
        ApiSymbolKind.RENDER,
        ApiSymbolKind.PAYLOAD,
        ApiSymbolKind.PROMPT,
        ApiSymbolKind.OUTPUT_PARSER,
        ApiSymbolKind.EXTRACTOR,
    }


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
