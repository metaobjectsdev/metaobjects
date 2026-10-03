"""`metaobjects.fmt.format_file` (#304 review follow-up) — direct tests for
the single-file formatter's overlay and BOM/CRLF handling, mirroring the
equivalent TS/C#/Java unit tests.
"""
from __future__ import annotations

from metaobjects.core_types import core_providers
from metaobjects.fmt import format_file
from metaobjects.provider import compose_registry

REGISTRY = compose_registry(list(core_providers))


def test_reports_overlay_even_when_a_local_base_exists_never_merges() -> None:
    # A plain Widget AND a same-(type,name) overlay:true redeclaration, both in
    # this one file. parse_document never merges within one document at all
    # (that is loader/merge.py's job, never called here), so this already
    # behaves correctly — but it is the behavior the OTHER three ports had to
    # be fixed to match: a formatter never changes structure.
    doc = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "field.string": { "name": "sku" } }
      ]}},
      { "object.entity": { "name": "Widget", "overlay": true, "children": [
        { "field.string": { "name": "notes" } }
      ]}}
    ]}}
    """
    result = format_file(doc, REGISTRY, "meta.widget.json")
    assert not result.ok
    assert result.overlay


def test_strips_bom_and_normalizes_crlf() -> None:
    body = (
        '{ "metadata.root": { "package": "acme", "children": [\n'
        '  { "object.entity": { "name": "Gadget", "children": [] } }\n'
        "]}}\n"
    )
    with_bom = "﻿" + body.replace("\n", "\r\n")
    result = format_file(with_bom, REGISTRY, "meta.gadget.json")
    assert result.ok
    assert result.text[0] != "﻿"
    assert "\r\n" not in result.text
