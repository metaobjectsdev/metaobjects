"""object.* → Pydantic v2 model module (sub-project A)."""
from __future__ import annotations

from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.validator import validator_constants as vc
from metaobjects.shared.base_types import TYPE_VALIDATOR
from metaobjects.shared.separators import PACKAGE_SEP
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.type_map import py_type_for
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator, per_entity
from metaobjects.codegen.generators.m2m_codegen import (
    build_object_index,
    resolve_m2m_descriptors,
)


def _is_int(value: object) -> bool:
    """A real int (bool is an int subclass, so `@maxLength: true` etc. must not count)."""
    return isinstance(value, int) and not isinstance(value, bool)


def _validators(field: MetaField, sub_type: str) -> list[MetaField]:
    """The field's own ``validator.<sub_type>`` children (effective, supers included)."""
    return [
        c
        for c in field.children()
        if c.type == TYPE_VALIDATOR and c.sub_type == sub_type
    ]


def _first_attr(field: MetaField, sub_type: str, attr_name: str) -> object | None:
    """First int-valued *attr_name* across the field's ``validator.<sub_type>`` children."""
    for v in _validators(field, sub_type):
        val = v.attr(attr_name)
        if _is_int(val):
            return val
    return None


def _validator_constraints(field: MetaField) -> dict[str, object]:
    """Map the field's ``validator.*`` children + field attrs to Pydantic ``Field``
    kwargs. Cross-port-canonical semantics (TS is the reference):

    - ``validator.regex @pattern`` -> ``pattern=``
    - ``validator.numeric @min/@max`` -> ``ge=``/``le=`` (numeric value bounds)
    - ``validator.length @min`` + field ``@maxLength`` -> ``min_length=``/``max_length=``
    - ``validator.array @min/@max`` -> list ``min_length=``/``max_length=`` (element count)
    """
    kwargs: dict[str, object] = {}

    # String length: validator.length @min/@max + field @maxLength (max wins per field attr).
    min_len = _first_attr(field, vc.VALIDATOR_SUBTYPE_LENGTH, vc.VALIDATOR_ATTR_MIN)
    max_len = _first_attr(field, vc.VALIDATOR_SUBTYPE_LENGTH, vc.VALIDATOR_ATTR_MAX)
    field_max = field.attr(fc.FIELD_ATTR_MAX_LENGTH)
    if _is_int(field_max):
        max_len = field_max
    if min_len is not None:
        kwargs["min_length"] = min_len
    if max_len is not None:
        kwargs["max_length"] = max_len

    # Array element count: validator.array @min/@max -> list min_length/max_length.
    arr_min = _first_attr(field, vc.VALIDATOR_SUBTYPE_ARRAY, vc.VALIDATOR_ATTR_MIN)
    arr_max = _first_attr(field, vc.VALIDATOR_SUBTYPE_ARRAY, vc.VALIDATOR_ATTR_MAX)
    if arr_min is not None:
        kwargs["min_length"] = arr_min
    if arr_max is not None:
        kwargs["max_length"] = arr_max

    # Numeric value bounds: validator.numeric @min/@max -> ge/le.
    num_min = _first_attr(field, vc.VALIDATOR_SUBTYPE_NUMERIC, vc.VALIDATOR_ATTR_MIN)
    num_max = _first_attr(field, vc.VALIDATOR_SUBTYPE_NUMERIC, vc.VALIDATOR_ATTR_MAX)
    if num_min is not None:
        kwargs["ge"] = num_min
    if num_max is not None:
        kwargs["le"] = num_max

    # Regex: validator.regex @pattern -> pattern.
    for v in _validators(field, vc.VALIDATOR_SUBTYPE_REGEX):
        pattern = v.attr(vc.VALIDATOR_ATTR_PATTERN)
        if isinstance(pattern, str):
            kwargs["pattern"] = pattern
            break

    return kwargs


def _field_line(field: MetaField, imports: set[str]) -> tuple[str, bool]:
    """Return (source line, uses_field). Collects required imports into *imports*."""
    pt = py_type_for(field)
    imports.update(pt.imports)
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        ref = field.attr(fc.FIELD_ATTR_OBJECT_REF)
        if ref:
            imports.add(f"from .{ref} import {ref}")
    required = field.attr(fc.FIELD_ATTR_REQUIRED) is True

    constraints = _validator_constraints(field)
    # Emit kwargs in a stable order so generated output is deterministic.
    _order = ["pattern", "ge", "le", "min_length", "max_length"]
    parts = [f"{k}={constraints[k]!r}" for k in _order if k in constraints]
    uses_field = bool(parts)

    annotation = pt.expr if required else f"{pt.expr} | None"
    if required and uses_field:
        assignment = f" = Field({', '.join(parts)})"
    elif required:
        assignment = ""
    elif uses_field:
        assignment = f" = Field(default=None, {', '.join(parts)})"
    else:
        assignment = " = None"

    return f"    {field.name}: {annotation}{assignment}", uses_field


def _effective_fqn(entity: MetaObject) -> str:
    """`package::name`, resolving the package from the nearest ancestor that carries
    one (objects inherit the file/root package). Falls back to the bare name."""
    pkg = entity.package
    parent = entity.parent
    while pkg is None and parent is not None:
        pkg = parent.package
        parent = parent.parent
    return f"{pkg}{PACKAGE_SEP}{entity.name}" if pkg else entity.name


class EntityModelGenerator:
    """``object.*`` → a Pydantic v2 model module per object.

    EXTENSION SEAM (open-for-extension). Adopters subclass this and override one of
    the protected ``_emit_*`` hooks (or ``render_entity_model``) to customize the
    emitted model without forking the generator. The factory ``entity_model()`` and
    the module-level ``render_entity_model()`` both delegate to a default instance,
    so subclassing changes nothing for the default suite (output stays byte-identical).

    Override points (in emission order):

    * ``_emit_class_header(entity, base_class)`` — the ``class <Name>(<Base>):`` line.
    * ``_emit_field_lines(entity, imports)`` — the body field lines (scalars + M:N
      collections); collect any extra imports into the ``imports`` set.
    * ``render_entity_model(entity, object_index)`` — the whole module (last resort).
    """

    name = "entity-model"

    def _emit_class_header(self, entity: MetaObject, base_class: str) -> str:
        """The ``class <Name>(<Base>):`` declaration line. Override to inject a
        decorator, a metaclass, or an alternate base."""
        return f"class {entity.name}({base_class}):"

    def _emit_field_lines(
        self,
        entity: MetaObject,
        imports: set[str],
        object_index: dict[str, MetaObject] | None,
    ) -> tuple[list[str], bool]:
        """The model body: one line per own field, then M:N nested collections when
        *object_index* is supplied. Returns ``(lines, uses_field)`` where
        ``uses_field`` is True iff any line used a pydantic ``Field(...)`` (so the
        caller knows to import ``Field``). Required imports are collected into
        *imports*. Override to add/transform body lines."""
        uses_field = False
        lines: list[str] = []
        for f in entity.own_fields():
            line, used = _field_line(f, imports)
            uses_field = uses_field or used
            lines.append(line)

        # M:N nested collections (FR-018). Element type is the target entity; a
        # self-join element type is a forward-ref string so the model can name itself.
        if object_index is not None:
            for d in resolve_m2m_descriptors(entity, object_index):
                if d.target_entity == entity.name:
                    element = f'"{entity.name}"'
                else:
                    element = d.target_entity
                    imports.add(f"from .{d.target_entity} import {d.target_entity}")
                lines.append(f"    {d.relation_name}: list[{element}] = []")
        return lines, uses_field

    def render_entity_model(
        self, entity: MetaObject, object_index: dict[str, MetaObject] | None = None
    ) -> str:
        """Render an entity as a Pydantic v2 model (pre-format; the generator runs ruff).

        When *object_index* is supplied, M:N navigations (``relationship.*``
        ``@cardinality:"many" + @through``) are emitted as nested Pydantic
        collections (``tags: list[Tag] = []``); a self-join uses a forward-ref string
        (``following: list["Person"] = []``). Without an index, only scalar/object
        fields are emitted (back-compat)."""
        imports: set[str] = set()
        base_class = "BaseModel"
        if entity.super_data is not None:
            base_class = entity.super_data.name
            imports.add(f"from .{base_class} import {base_class}")

        lines, uses_field = self._emit_field_lines(entity, imports, object_index)
        body = lines if lines else ["    pass"]

        # Import only the pydantic names actually referenced.
        pyd_names: list[str] = []
        if entity.super_data is None:
            pyd_names.append("BaseModel")
        if uses_field:
            pyd_names.append("Field")

        parts: list[str] = [
            generated_header(entity.name, _effective_fqn(entity)),
            "from __future__ import annotations",
            "",
        ]
        extra_imports = sorted(imports)
        if extra_imports:
            parts += [*extra_imports, ""]
        if pyd_names:
            parts += [f"from pydantic import {', '.join(pyd_names)}", ""]
        parts += ["", self._emit_class_header(entity, base_class), *body, ""]
        return "\n".join(parts)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        index = build_object_index(ctx.entities)
        return per_entity(
            lambda e, _c: EmittedFile(
                path=f"{e.name}.py",
                content=ruff_format(self.render_entity_model(e, index)),
            )
        )(ctx)


def render_entity_model(
    entity: MetaObject, object_index: dict[str, MetaObject] | None = None
) -> str:
    """Module-level back-compat wrapper. Delegates to a default
    :class:`EntityModelGenerator` instance so existing callers (and the golden
    tests) are unaffected. Subclass :class:`EntityModelGenerator` to customize."""
    return EntityModelGenerator().render_entity_model(entity, object_index)


def entity_model() -> Generator:
    """Generator factory: object.* → a Pydantic model module per object.

    Returns an :class:`EntityModelGenerator` (subclassable extension seam)."""
    return EntityModelGenerator()
