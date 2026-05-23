"""object.* → Pydantic v2 model module (sub-project A)."""
from __future__ import annotations

from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.shared.separators import PACKAGE_SEP
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.type_map import py_type_for
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator, per_entity


def _field_line(field: MetaField, imports: set[str]) -> tuple[str, bool]:
    """Return (source line, uses_field). Collects required imports into *imports*."""
    pt = py_type_for(field)
    imports.update(pt.imports)
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        ref = field.attr(fc.FIELD_ATTR_OBJECT_REF)
        if ref:
            imports.add(f"from .{ref} import {ref}")
    required = field.attr(fc.FIELD_ATTR_REQUIRED) is True
    max_len = field.attr(fc.FIELD_ATTR_MAX_LENGTH)
    # bool is an int subclass, so `@maxLength: true` must not be read as a length.
    uses_field = isinstance(max_len, int) and not isinstance(max_len, bool)

    annotation = pt.expr if required else f"{pt.expr} | None"
    if required and uses_field:
        assignment = f" = Field(max_length={max_len})"
    elif required:
        assignment = ""
    elif uses_field:
        assignment = f" = Field(default=None, max_length={max_len})"
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
