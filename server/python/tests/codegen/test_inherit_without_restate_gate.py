"""GATE / TRIPWIRE for issue #56 — codegen must read inherited attributes via the
EFFECTIVE accessor (``attrs()``), not the own-only ``attr()`` (which, despite its
name, does NOT walk the ``extends`` super chain in this port).

This test asserts the CORRECT behavior and is RED until #56 is fixed: a field that
inherits ``@required`` via ``extends`` (abstract-field reuse) without restating it must
generate as a REQUIRED Pydantic field, not ``Optional``. ``entity_model.py`` currently
reads ``field.attr(@required)`` (own-only) → the inherited ``@required`` is invisible →
the field is wrongly emitted as optional. See #56 for the full cross-port inventory.
"""
from __future__ import annotations

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.generators.entity_model import render_entity_model

_MODEL = """
{ "metadata.root": { "package": "test", "children": [
  { "object.entity": { "name": "Base", "abstract": true, "children": [
    { "field.string": { "name": "baseLabel", "@required": true, "@maxLength": 80 } }
  ] } },
  { "object.entity": { "name": "Widget", "children": [
    { "source.rdb": { "@table": "widgets" } },
    { "field.long": { "name": "id" } },
    { "field.string": { "name": "label", "extends": "test::Base.baseLabel" } },
    { "identity.primary": { "name": "primary", "@fields": ["id"], "@generation": "increment" } }
  ] } }
] } }
"""


def _widget() -> MetaObject:
    result = MetaDataLoader.from_string(_MODEL)
    assert not result.errors, [str(e) for e in result.errors]
    widget = next(c for c in result.root.children()
                  if getattr(c, "name", None) == "Widget")
    assert isinstance(widget, MetaObject)
    return widget


def test_inherited_required_field_generates_as_required() -> None:
    widget = _widget()
    label = next(f for f in widget.fields() if f.name == "label")

    # Root cause: effective sees the inherited @required; own-only does not.
    assert label.attrs().get("required") is True   # effective
    assert label.attr("required") is None           # own-only misses it (the trap)

    # The gate: an inherited @required must produce a REQUIRED field, not Optional.
    # RED until #56 is fixed (entity_model reads field.attr(@required) own-only).
    source = render_entity_model(widget)
    # Scope to the MAIN read model: the flat FR-036 WidgetCreate / WidgetPatch models
    # restate every field (Patch makes them optional), so split on the first validation
    # model. The invariant here is that an inherited @required field renders as
    # REQUIRED, not Optional, in the read model.
    main = source.split("class WidgetCreate")[0]
    assert "label: str" in main, source
    assert "label: Optional" not in main, source
    assert "label: str | None" not in main, source
