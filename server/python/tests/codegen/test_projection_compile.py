"""Regression guard: a projection (read-only, view-backed) must generate a model
that actually COMPILES, and its write generators must skip it.

This mirrors the C# port's DbContextCompileTests and the TypeScript projection
compile test added alongside the PR #80 fix: a string assertion ("no write
artifacts") can miss a generated-code defect that only a real compile catches.
Here we EXEC the generated Pydantic model — a syntax/name/import error fails the
test. A non-required derived field is included (the case that exposed a
nullable-column vs non-null-read-type mismatch in TS)."""

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import (
    SOURCE_ATTR_KIND,
    SOURCE_KIND_VIEW,
    SOURCE_SUBTYPE_RDB,
)
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_SOURCE


def _f(name: str, sub: str, *, required: bool = False) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    if required:
        f.set_attr(fc.FIELD_ATTR_REQUIRED, True)
    return f


def _view_projection() -> MetaObject:
    o = MetaObject(TYPE_OBJECT, "entity", "ProgramSummary")
    o.package = "acme::test"
    src = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "")
    src.set_attr(SOURCE_ATTR_KIND, SOURCE_KIND_VIEW, sub_type="string")
    o.add_child(src)
    o.add_child(_f("id", fc.FIELD_SUBTYPE_INT, required=True))
    o.add_child(_f("weekCount", fc.FIELD_SUBTYPE_INT))  # non-required derived field
    return o


def test_projection_model_compiles() -> None:
    src = render_entity_model(_view_projection())
    ns: dict[str, object] = {}
    # EXEC the emitted module — catches syntax/name/import defects a string
    # assertion would miss (the cross-port complement to TS's TS2724 guard).
    exec(compile(src, "<ProgramSummary model>", "exec"), ns)  # noqa: S102
    assert "ProgramSummary" in ns  # the Pydantic model class was defined


def test_projection_is_read_only() -> None:
    # A view-backed projection gets a model but NO write router.
    assert render_router(_view_projection()) is None
