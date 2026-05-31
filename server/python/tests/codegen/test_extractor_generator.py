"""Tests for the ``<Name>Extractor`` generator (cross-port extract tier).

The ``extract`` tier sits OVER the existing tolerant extract: it runs the
nested-capable ``extract_<snake>_with_loader``, raises when a ``@required`` field
was lost, and otherwise maps the all-nullable ``<Name>PayloadExtracted`` mirror
graph onto the STRICT ``<Name>Payload`` Pydantic graph via a generated recursive
mirror→strict mapper (recursing nested objects + arrays-of-objects).

Mirrors ``test_output_parser_generator.py``'s materialize→import→invoke harness.
The cross-port reference is the TS ``extractor-codegen.test.ts`` (Task 1) and the
Java ``ExtractorCodeGenerator``.
"""
from __future__ import annotations

import json

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
import pytest
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.extractor_generator import (
    ExtractorGenerator,
    extractor_generator,
    render_extractor,
)
from metaobjects.codegen.generators.output_parser_generator import OutputParserGenerator
from metaobjects.codegen.generators.payload_vo_generator import PayloadVoGenerator
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_TEMPLATE,
)
from metaobjects.shared.structural import KEY_IS_ARRAY


# ---------------------------------------------------------------------------
# Builders — a template.output "OrderOut" over an "Order" payload with a
# REQUIRED single nested object, a REQUIRED array-of-objects, a REQUIRED
# scalar-array, an OPTIONAL scalar, and an OPTIONAL single nested object.
# ---------------------------------------------------------------------------


def _field(name: str, sub: str, **attrs: object) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    for k, v in attrs.items():
        f.set_attr(k, v)
    return f


def _value_object(name: str, fields: list[MetaField]) -> MetaObject:
    obj = MetaObject(TYPE_OBJECT, "value", name)
    for f in fields:
        obj.add_child(f)
    return obj


def _output_template(name: str, payload_ref: str, *, fmt: str = "json") -> MetaTemplate:
    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT, name)
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, payload_ref)
    tmpl.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, "tpl/output")
    tmpl.set_attr(tc.TEMPLATE_ATTR_FORMAT, fmt)
    return tmpl


def _order_root() -> MetaRoot:
    customer = _value_object(
        "Customer",
        [_field("name", fc.FIELD_SUBTYPE_STRING, **{fc.FIELD_ATTR_REQUIRED: True})],
    )
    line = _value_object(
        "Line",
        [
            _field("sku", fc.FIELD_SUBTYPE_STRING, **{fc.FIELD_ATTR_REQUIRED: True}),
            _field("qty", fc.FIELD_SUBTYPE_INT, **{fc.FIELD_ATTR_REQUIRED: True}),
        ],
    )
    order = _value_object(
        "Order",
        [
            _field(
                "customer",
                fc.FIELD_SUBTYPE_OBJECT,
                **{fc.FIELD_ATTR_OBJECT_REF: "Customer", fc.FIELD_ATTR_REQUIRED: True},
            ),
            _field(
                "lines",
                fc.FIELD_SUBTYPE_OBJECT,
                **{
                    fc.FIELD_ATTR_OBJECT_REF: "Line",
                    fc.FIELD_ATTR_REQUIRED: True,
                    KEY_IS_ARRAY: True,
                },
            ),
            _field(
                "tags",
                fc.FIELD_SUBTYPE_STRING,
                **{fc.FIELD_ATTR_REQUIRED: True, KEY_IS_ARRAY: True},
            ),
            _field(
                "scores",
                fc.FIELD_SUBTYPE_INT,
                **{fc.FIELD_ATTR_REQUIRED: True, KEY_IS_ARRAY: True},
            ),
            _field("note", fc.FIELD_SUBTYPE_STRING),  # optional scalar
            _field(
                "ship_to",
                fc.FIELD_SUBTYPE_OBJECT,
                **{fc.FIELD_ATTR_OBJECT_REF: "Customer"},  # optional single nested
            ),
        ],
    )
    tmpl = _output_template("OrderOut", "Order")
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    root.package = "acme::ai"
    for c in (customer, line, order, tmpl):
        root.add_child(c)
    return root


def _ctx(root: MetaRoot, *, out_dir: str = "/tmp/out") -> GenContext:
    return GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir=out_dir),
        warn=lambda _m: None,
    )


# ---------------------------------------------------------------------------
# render_extractor — text-level shape assertions.
# ---------------------------------------------------------------------------


def test_render_emits_extract_and_extract_and_mappers() -> None:
    out = render_extractor(_order_root().own_children()[3], _order_root())
    assert out is not None
    # extract returns the STRICT payload type, routes through the with-loader extract.
    assert "def extract_order_out(root, text, opts=None) -> OrderOutPayload:" in out
    assert "extract_lenient_order_out_with_loader(root, text, opts)" in out
    assert "if r.report.has_lost_required():" in out
    # re-exposed extract under the public name, delegating to the nested-capable path.
    assert "def extract_lenient_order_out(root, text, opts=None):" in out
    # imports the strict payload graph + the with-loader extract.
    assert (
        "from .order_out_output_parser import extract_lenient_order_out_with_loader" in out
    )
    assert "from .order_out_payload import" in out
    # one mapper per type in the graph (root + nested).
    assert "def _to_strict_order(" in out
    assert "def _to_strict_customer(" in out
    assert "def _to_strict_line(" in out


def test_render_returns_none_when_payload_ref_unresolved() -> None:
    tmpl = _output_template("StrayOutput", "DoesNotExist")
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    root.add_child(tmpl)
    assert render_extractor(tmpl, root) is None


def test_render_returns_none_for_text_format() -> None:
    """No extract API for text-format outputs → no extract tier."""
    payload = _value_object("P", [_field("x", fc.FIELD_SUBTYPE_STRING)])
    tmpl = _output_template("TextOut", "P", fmt="text")
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    for c in (payload, tmpl):
        root.add_child(c)
    assert render_extractor(tmpl, root) is None


def test_factory_returns_generator_with_expected_name() -> None:
    gen = extractor_generator()
    assert gen.name == "extractor-generator"


def test_generator_emits_one_file_per_template_output() -> None:
    files = ExtractorGenerator().generate(_ctx(_order_root()))
    assert [f.path for f in files] == ["order_out_extractor.py"]


# ---------------------------------------------------------------------------
# Compile-and-run — materialize the emitted package, import, invoke.
# ---------------------------------------------------------------------------


def _materialize_package(files: list, tmp_path) -> str:
    import os

    pkg_dir = str(tmp_path / "_gen_pkg")
    os.makedirs(pkg_dir, exist_ok=True)
    open(os.path.join(pkg_dir, "__init__.py"), "w").close()
    for f in files:
        with open(os.path.join(pkg_dir, f.path), "w") as fh:
            fh.write(f.content)
    return pkg_dir


def _import_package(pkg_dir: str, monkeypatch) -> None:
    import importlib
    import sys

    parent = pkg_dir.rsplit("/", 1)[0]
    monkeypatch.syspath_prepend(parent)
    for k in list(sys.modules):
        if k == "_gen_pkg" or k.startswith("_gen_pkg."):
            del sys.modules[k]
    importlib.import_module("_gen_pkg")


def _all_files(root: MetaRoot) -> list:
    return (
        ExtractorGenerator().generate(_ctx(root))
        + OutputParserGenerator().generate(_ctx(root))
        + PayloadVoGenerator().generate(_ctx(root))
    )


def test_extract_extracts_dirty_into_strict_payload(tmp_path, monkeypatch) -> None:
    from importlib import import_module

    root = _order_root()
    pkg_dir = _materialize_package(_all_files(root), tmp_path)
    _import_package(pkg_dir, monkeypatch)
    ex = import_module("_gen_pkg.order_out_extractor")

    dirty = (
        "Sure, here you go!\n```json\n"
        '{ "customer": {"name": "Ada"}, '
        '"lines": [{"sku":"A","qty":2},{"sku":"B","qty":1}], '
        '"tags": ["x","y"], '
        '"scores": [3, 7] }\n```'
    )
    order = ex.extract_order_out(root, dirty)
    # nested single populated + typed.
    assert order.customer.name == "Ada"
    # array-of-objects populated + typed.
    assert len(order.lines) == 2
    assert order.lines[0].sku == "A"
    assert order.lines[1].qty == 1
    # scalar array → list[str], no None elements.
    assert order.tags == ["x", "y"]
    # NON-string scalar array → list[int], coerced per-kind (cross-port parity).
    assert order.scores == [3, 7]
    assert all(isinstance(s, int) for s in order.scores)
    # optional nested absent → None.
    assert order.ship_to is None


def test_extract_raises_on_lost_required(tmp_path, monkeypatch) -> None:
    from importlib import import_module

    root = _order_root()
    pkg_dir = _materialize_package(_all_files(root), tmp_path)
    _import_package(pkg_dir, monkeypatch)
    ex = import_module("_gen_pkg.order_out_extractor")

    # missing the required `customer` (and tags) → lost-required → raises.
    with pytest.raises(ValueError, match="lost required"):
        ex.extract_order_out(root, '{ "lines": [] }')


def test_extract_reexposed_never_raises_and_no_lost_required(tmp_path, monkeypatch) -> None:
    from importlib import import_module

    root = _order_root()
    pkg_dir = _materialize_package(_all_files(root), tmp_path)
    _import_package(pkg_dir, monkeypatch)
    ex = import_module("_gen_pkg.order_out_extractor")

    clean = json.dumps(
        {
            "customer": {"name": "Ada"},
            "lines": [{"sku": "A", "qty": 2}],
            "tags": ["x"],
            "scores": [3, 7],
        }
    )
    r = ex.extract_lenient_order_out(root, clean)
    assert r.report.has_lost_required() is False
    # nested populated in the mirror too (with-loader path).
    assert r.data.customer.name == "Ada"
