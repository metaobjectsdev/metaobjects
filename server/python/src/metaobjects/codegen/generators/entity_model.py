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


def render_entity_model(entity: MetaObject) -> str:
    """Render an entity as a Pydantic v2 model (pre-format; the generator runs ruff)."""
    imports: set[str] = set()
    base_class = "BaseModel"
    if entity.super_data is not None:
        base_class = entity.super_data.name
        imports.add(f"from .{base_class} import {base_class}")

    uses_field = False
    lines: list[str] = []
    for f in entity.own_fields():
        line, used = _field_line(f, imports)
        uses_field = uses_field or used
        lines.append(line)
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
    parts += ["", f"class {entity.name}({base_class}):", *body, ""]
    return "\n".join(parts)


def entity_model() -> Generator:
    """Generator: object.* → a Pydantic model module per object."""

    class _Gen:
        name = "entity-model"

        def generate(self, ctx: GenContext) -> list[EmittedFile]:
            return per_entity(
                lambda e, _c: EmittedFile(
                    path=f"{e.name}.py",
                    content=ruff_format(render_entity_model(e)),
                )
            )(ctx)

    return _Gen()
