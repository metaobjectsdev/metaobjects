"""#195 — the ``origin_guaranteed_non_null`` contract drives read-model nullability.

A projection field derived by ``origin.aggregate @agg:any|all|collect`` is
COALESCE-guaranteed non-null in the synthesized view (any→false, all→true,
collect→[]), so the generated Pydantic read model types it as MANDATORY even when
the field is not ``@required``. ``origin.first`` (an empty related set selects no
row → null) and ``origin.computed`` (nullability is expression-dependent) stay the
conservative nullable default.

Mirrors the TS ``codegen-ts`` ``projection-decl.test.ts`` "#195 projection
read-schema nullability" block — the Python port had the ``origin_guaranteed_non_null``
logic (``entity_model.py``) but no test pinning it.
"""

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects.codegen.generators.entity_model import (
    origin_guaranteed_non_null,
    render_entity_model,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.origin.meta_origin import MetaOrigin
from metaobjects.meta.persistence.origin.origin_constants import (
    AGG_ALL,
    AGG_ANY,
    AGG_COLLECT,
    ORIGIN_ATTR_AGG,
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_COMPUTED,
    ORIGIN_SUBTYPE_FIRST,
)
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import (
    SOURCE_ATTR_KIND,
    SOURCE_KIND_VIEW,
    SOURCE_SUBTYPE_RDB,
)
from metaobjects.shared.base_types import (
    TYPE_FIELD,
    TYPE_OBJECT,
    TYPE_ORIGIN,
    TYPE_SOURCE,
)


def _aggregate(agg: str) -> MetaOrigin:
    o = MetaOrigin(TYPE_ORIGIN, ORIGIN_SUBTYPE_AGGREGATE, agg)
    o.set_attr(ORIGIN_ATTR_AGG, agg)
    return o


def _origin(sub_type: str) -> MetaOrigin:
    return MetaOrigin(TYPE_ORIGIN, sub_type, "")


def _field(
    name: str, sub: str, origin: MetaOrigin, *, is_array: bool = False
) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    f.is_array = is_array
    f.add_child(origin)
    return f


# ── origin_guaranteed_non_null (the function under test) ─────────────────────


def test_guaranteed_non_null_true_for_any_all_collect() -> None:
    for agg in (AGG_ANY, AGG_ALL, AGG_COLLECT):
        f = _field("x", fc.FIELD_SUBTYPE_BOOLEAN, _aggregate(agg))
        assert origin_guaranteed_non_null(f) is True, agg


def test_guaranteed_non_null_false_for_first_and_computed() -> None:
    for sub in (ORIGIN_SUBTYPE_FIRST, ORIGIN_SUBTYPE_COMPUTED):
        f = _field("x", fc.FIELD_SUBTYPE_STRING, _origin(sub))
        assert origin_guaranteed_non_null(f) is False, sub


def test_guaranteed_non_null_false_without_origin() -> None:
    plain = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "x")
    assert origin_guaranteed_non_null(plain) is False


# ── end-to-end read-model typing ─────────────────────────────────────────────


def _projection() -> MetaObject:
    """A view-backed read projection carrying one field per #195 origin kind — all
    NON-required, so nullability is decided purely by origin_guaranteed_non_null."""
    o = MetaObject(TYPE_OBJECT, "entity", "OrderInsights")
    o.package = "acme::test"
    src = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "")
    src.set_attr(SOURCE_ATTR_KIND, SOURCE_KIND_VIEW, sub_type="string")
    o.add_child(src)
    o.add_child(MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_INT, "id"))
    o.add_child(_field("hasLong", fc.FIELD_SUBTYPE_BOOLEAN, _aggregate(AGG_ANY)))
    o.add_child(_field("allLong", fc.FIELD_SUBTYPE_BOOLEAN, _aggregate(AGG_ALL)))
    o.add_child(
        _field(
            "labels", fc.FIELD_SUBTYPE_STRING, _aggregate(AGG_COLLECT), is_array=True
        )
    )
    o.add_child(
        _field("latest", fc.FIELD_SUBTYPE_STRING, _origin(ORIGIN_SUBTYPE_FIRST))
    )
    o.add_child(
        _field("flag", fc.FIELD_SUBTYPE_BOOLEAN, _origin(ORIGIN_SUBTYPE_COMPUTED))
    )
    return o


def test_read_model_typing_any_all_collect_mandatory_first_computed_optional() -> None:
    # A view-backed projection is read-only (no Create/Patch model), so the whole
    # rendered module is the read model.
    read_model = render_entity_model(_projection())

    # any / all / collect → COALESCE-guaranteed → mandatory, NO ``| None``.
    assert "hasLong: bool" in read_model
    assert "hasLong: bool | None" not in read_model
    assert "allLong: bool" in read_model
    assert "allLong: bool | None" not in read_model
    assert "labels: list[str]" in read_model
    assert "labels: list[str] | None" not in read_model

    # first / computed → conservative nullable.
    assert "latest: str | None" in read_model
    assert "flag: bool | None" in read_model
