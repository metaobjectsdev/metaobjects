"""Turns a payload value-object into Python source fragments for the FR-010 extract
codegen:

* :func:`schema_literal`       — a ``ExtractSchema(Format.X, "root", [FieldSpec(...), …])``
                                 baked descriptor for the emitted parser module.
* :func:`mirror_dataclass`     — an all-nullable mirror dataclass ``<Payload>Extracted``
                                 (every field ``X | None = None``; the extract entry
                                 returns this nullable twin rather than the strict
                                 Pydantic payload — same reasoning as the Kotlin / C#
                                 nullable mirror).
* :func:`mirror_initializer`   — ``<Name>Extracted(field=as_string(d, "field"), …)``.

Mirrors the C# / Java ``ExtractSchemaEmitter`` adapted to Python syntax + the
nullable-mirror shape. Bounded scope: scalar / enum / scalar-array. Nested object +
array-of-enum deferred.
"""
from __future__ import annotations

from metaobjects.codegen import fr010_field_mapping as fm
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_data import MetaData

# The extract_map accessors a generated module may import (sorted, deduped subset).
ALL_EXTRACT_MAP_HELPERS: tuple[str, ...] = (
    "as_bool",
    "as_double",
    "as_int",
    "as_long",
    "as_string",
    "as_string_list",
)


def _format_enum(fmt: str) -> str:
    return "Format.XML" if fmt.lower() == "xml" else "Format.JSON"


def _field_spec_literal(field: MetaData, owner: MetaData) -> str:
    name = field.name
    required = fm.is_required(field)
    req = "True" if required else "False"

    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        values_lit = fm.string_list_literal(fm.enum_values(field))
        alias_lit = fm.properties_map_literal(field.attr(fc.FIELD_ATTR_ENUM_ALIAS))
        # FR-011: resolve the three new enum args (field → object.value → "strip" for
        # normalize). Keep the back-compat 4-arg form when nothing is set; otherwise
        # emit the 7-arg form (..., coerce_default, normalize, default_value).
        coerce_default = fm.coerce_default(field)
        default_value = fm.default_value(field)
        normalize = fm.resolve_normalize(field, owner)
        if (
            coerce_default is None
            and default_value is None
            and normalize == fc.NORMALIZE_DEFAULT
        ):
            return f'FieldSpec.enum_field("{name}", {req}, {values_lit}, {alias_lit})'
        cd_lit = "None" if coerce_default is None else fm.py_string_literal(coerce_default)
        norm_lit = fm.py_string_literal(normalize)
        dv_lit = "None" if default_value is None else fm.py_string_literal(default_value)
        return (
            f'FieldSpec.enum_field("{name}", {req}, {values_lit}, {alias_lit}, '
            f"{cd_lit}, {norm_lit}, {dv_lit})"
        )

    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        # Self-contained path models a nested object as a plain (opaque) STRING scalar
        # slot — it does not recurse. The runtime-delegating ``*_with_loader`` entry
        # populates the real nested graph. (No trailing inline comment: this literal is
        # joined into a ``[...]`` argument list, where a ``#`` comment would be illegal.)
        return f'FieldSpec.scalar("{name}", FieldKind.STRING, {req})'

    kind = fm.scalar_kind(field.sub_type) or "STRING"
    return f'FieldSpec.scalar("{name}", FieldKind.{kind}, {req})'


def schema_literal(vo: MetaData, fmt: str, root_name: str) -> str:
    """Emit ``ExtractSchema(Format.X, "rootName", [FieldSpec(...), …])``."""
    format_enum = _format_enum(fmt)
    specs = [_field_spec_literal(f, vo) for f in fm.fields(vo)]
    if not specs:
        return f'ExtractSchema({format_enum}, "{root_name}", [])'
    body = ", ".join(specs)
    return f'ExtractSchema({format_enum}, "{root_name}", [{body}])'


def mirror_dataclass(vo: MetaData, record_name: str) -> list[str]:
    """Emit the all-nullable mirror dataclass declaration (source lines)."""
    base = (
        record_name[: -len("Extracted")]
        if record_name.endswith("Extracted")
        else record_name
    )
    lines: list[str] = [
        "@dataclass(frozen=True, slots=True)",
        f"class {record_name}:",
        f'    """Best-effort extracted twin of ``{base}`` — every field nullable',
        '    (``None`` where the value was lost or malformed)."""',
    ]
    field_lines = [
        f"    {f.name}: {fm.mirror_type(f)} = None" for f in fm.fields(vo)
    ]
    if field_lines:
        lines.extend(field_lines)
    else:
        lines.append("    pass")
    return lines


def mirror_initializer(vo: MetaData, record_name: str) -> str:
    """Emit ``<recordName>(field=as_string(d, "field"), …)``."""
    assigns = [f"{f.name}={fm.extract_map_call(f)}" for f in fm.fields(vo)]
    return f"{record_name}({', '.join(assigns)})"


def extract_map_imports(vo: MetaData) -> list[str]:
    """The sorted, deduped ``extract_map`` accessor names the mirror initializer needs."""
    used: set[str] = set()
    for f in fm.fields(vo):
        h = fm.extract_map_helper(f)
        if h is not None:
            used.add(h)
    return [h for h in ALL_EXTRACT_MAP_HELPERS if h in used]
