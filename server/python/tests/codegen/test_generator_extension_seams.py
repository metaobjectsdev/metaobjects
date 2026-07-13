"""Open-for-extension contract for the Python code generators.

Each generator that owns a non-trivial emit is a NAMED, subclassable class whose
``generate()`` / ``render_*`` delegates to overridable ``_emit_*`` hooks. An adopter
can subclass and override a hook to customize emitted output WITHOUT forking — while
the default (unsubclassed) generator output stays byte-identical.

This module proves both halves for every refactored generator:

* the override changes the output, AND
* the default instance's output is unchanged by the existence of the subclass.
"""
import metaobjects.core_types  # noqa: F401  — registers attr classes (set_attr needs them)
from metaobjects.codegen.generators.entity_model import (
    EntityModelGenerator,
    render_entity_model,
)
from metaobjects.codegen.generators.filter_allowlist_generator import (
    FilterAllowlistGenerator,
    render_filter_allowlist,
)
from metaobjects.codegen.generators.router_generator import (
    RouterGenerator,
    render_router,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import SOURCE_SUBTYPE_RDB
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_SOURCE


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #


def _f(name: str, sub: str, *, required: bool = False, filterable: bool = False) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    if required:
        f.set_attr(fc.FIELD_ATTR_REQUIRED, True)
    if filterable:
        f.set_attr(fc.FIELD_ATTR_FILTERABLE, True)
    return f


def _table_entity(name: str, fields: list[MetaField], *, package: str | None = None) -> MetaObject:
    o = MetaObject(TYPE_OBJECT, "entity", name)
    o.package = package
    o.add_child(MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, ""))  # default kind=table
    for f in fields:
        o.add_child(f)
    return o


def _entity(name: str, fields: list[MetaField], *, package: str | None = None) -> MetaObject:
    o = MetaObject(TYPE_OBJECT, "entity", name)
    o.package = package
    for f in fields:
        o.add_child(f)
    return o


# --------------------------------------------------------------------------- #
# EntityModelGenerator — override _emit_class_header
# --------------------------------------------------------------------------- #


def test_entity_model_class_header_override() -> None:
    class _CustomEntityGen(EntityModelGenerator):
        def _emit_class_header(self, entity: MetaObject, base_class: str) -> str:
            # Inject a decorator above the class declaration.
            return f"@my_decorator\nclass {entity.name}({base_class}):"

    e = _entity(
        "Subscriber",
        [_f("email", fc.FIELD_SUBTYPE_STRING, required=True)],
        package="myapp::users",
    )

    overridden = _CustomEntityGen().render_entity_model(e)
    default = render_entity_model(e)

    # Override takes effect.
    assert "@my_decorator" in overridden
    assert "@my_decorator\nclass Subscriber(BaseModel):" in overridden
    # Default (unsubclassed) output is unchanged — no decorator leaked in.
    assert "@my_decorator" not in default
    assert "class Subscriber(BaseModel):" in default
    # And the default still equals a fresh default instance (no shared mutation).
    assert default == EntityModelGenerator().render_entity_model(e)


# --------------------------------------------------------------------------- #
# RouterGenerator — override _emit_repository_protocol
# --------------------------------------------------------------------------- #


def test_router_repository_protocol_override() -> None:
    class _CustomRouterGen(RouterGenerator):
        def _emit_repository_protocol(self, repo_class, m2m, pk_type):
            lines = super()._emit_repository_protocol(repo_class, m2m, pk_type)
            lines.append("    def custom_finder(self, q: str) -> list: ...")
            return lines

    e = _table_entity(
        "Author",
        [
            _f("id", fc.FIELD_SUBTYPE_INT, required=True),
            _f("name", fc.FIELD_SUBTYPE_STRING, required=True),
        ],
        package="acme::blog",
    )

    overridden = _CustomRouterGen().render_router(e)
    default = render_router(e)

    assert overridden is not None and default is not None
    # Override takes effect.
    assert "def custom_finder(self, q: str) -> list: ..." in overridden
    # Default output is unchanged.
    assert "custom_finder" not in default
    assert "class AuthorRepository(Protocol):" in default
    assert default == RouterGenerator().render_router(e)


# --------------------------------------------------------------------------- #
# FilterAllowlistGenerator — override _ops_for_field
# --------------------------------------------------------------------------- #


def test_filter_allowlist_ops_for_field_override() -> None:
    class _NarrowOpsGen(FilterAllowlistGenerator):
        def _ops_for_field(self, field: MetaField):
            # Restrict every filterable field to equality-only.
            return ("eq",)

    e = _table_entity(
        "Author",
        [
            _f("id", fc.FIELD_SUBTYPE_INT, required=True),
            _f("name", fc.FIELD_SUBTYPE_STRING, filterable=True),
        ],
        package="acme::blog",
    )

    overridden = _NarrowOpsGen().render_filter_allowlist(e)
    default = render_filter_allowlist(e)

    assert overridden is not None and default is not None
    # Override narrows the operator vocabulary to eq-only.
    assert '"name": frozenset({"eq"})' in overridden
    # Default keeps the full FR-009 string operator set (insertion order preserved).
    assert '"name": frozenset({"eq", "ne", "in", "like", "isNull"})' in default
    assert "eq" in overridden  # sanity
    assert default == FilterAllowlistGenerator().render_filter_allowlist(e)
