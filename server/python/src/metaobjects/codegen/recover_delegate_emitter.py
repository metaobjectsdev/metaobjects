"""FR-010 nested-codegen-gap — the runtime-DELEGATING recover emitter (Python).

The self-contained ``recover_<name>(text)`` path (``recover_schema_emitter`` + the
baked ``RecoverSchema``) covers scalars / enums / scalar-arrays but leaves
nested-object and array-of-object components ``None`` — the historical FR-010 codegen
gap. This module emits the additive *delegating* entry that CLOSES that gap by
wrapping the runtime recover:

    recover_<name>_with_loader(root, text, opts=None) -> RecoveryResult[<Name>Recovered]

It resolves this payload's ``MetaObject`` from the supplied loaded ``MetaRoot`` by its
baked simple name (``PAYLOAD_NAME``), delegates to ``recover_object`` in
:mod:`metaobjects.meta.core.object.object_recover` (which assembles the FULL nested
object graph reflection-free via the Phase A object model — ``MetaObject.new_instance()``
+ the ``MetaField`` set-by-name SPI), then maps the assembled ``ValueObject`` graph into
the typed nullable mirror graph via generated ``_from_<vo>_recovered(o)`` mapper
functions (payload + every reachable nested VO, deduped).

This is the codegen-wrapping-runtime pattern (a generated DAO calling the
dynamic-metadata runtime), mirroring the Java / Kotlin / TS pilots. The generated
mappers read the assembled graph through a tiny ``_read_prop`` helper that mirrors the
``MetaField`` get SPI (``ValueObject.get(name)`` else plain-attribute access), so the
emitted code stays self-sufficient and reflection-free.

Bounded by the cross-port ``MAX_NEST_DEPTH`` via the runtime — codegen here only mirrors
the runtime's resolved object graph, so depth/cycle guarding lives in ``object_recover``.
The emitter dedupes mirrors/mappers by VO simple name (cycle-safe).
"""
from __future__ import annotations

from metaobjects.codegen import fr010_field_mapping as fm
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.base_types import TYPE_OBJECT
from metaobjects.shared.separators import PACKAGE_SEP


def _find_object(root: MetaData, name: str) -> MetaData | None:
    """The own-child ``object.*`` node named *name*, or ``None``."""
    for c in root.own_children():
        if c.type == TYPE_OBJECT and c.name == name:
            return c
    return None


def _ref_vo(field: MetaData, root: MetaData) -> MetaData | None:
    """The ``@objectRef`` target VO for a nested-object field, or ``None`` when
    unresolvable. Matches first on the full ref, then the trailing simple-name
    segment (mirrors the runtime ``_resolve_object_ref`` short-name fallback)."""
    ref = field.attr(fc.FIELD_ATTR_OBJECT_REF)
    if not isinstance(ref, str) or not ref:
        return None
    direct = _find_object(root, ref)
    if direct is not None:
        return direct
    if PACKAGE_SEP in ref:
        return _find_object(root, ref.rsplit(PACKAGE_SEP, 1)[-1])
    return None


def _is_object_field(field: MetaData) -> bool:
    """True iff the field is a nested object reference (``field.object`` — distinct
    from the string-backed ``field.enum``, treated as a scalar)."""
    return field.sub_type == fc.FIELD_SUBTYPE_OBJECT


def mirror_name(vo: MetaData) -> str:
    """The recovered-mirror dataclass name for a value-object (``<Name>Recovered``)."""
    return f"{vo.name}Recovered"


def _mapper_name(vo: MetaData) -> str:
    """The mapper function name for a value-object (``_from_<name>_recovered``)."""
    return f"_from_{_snake(vo.name)}_recovered"


def root_mapper_name(template_name: str) -> str:
    """The root mapper's name — derived from the TEMPLATE (so it returns the
    canonically-named ``<Template>Recovered`` mirror)."""
    return f"_from_{_snake(template_name)}_recovered"


def _snake(name: str) -> str:
    """``NpcResponseOutput`` → ``npc_response_output`` (matches the cross-generator
    ``_snake_case`` convention; no acronym handling)."""
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


# =============================================================================
# Nested-aware mirror type (recurses into nested mirror names)
# =============================================================================


def _nested_mirror_type(field: MetaData, root: MetaData) -> str:
    """The nullable mirror annotation for one field — nested-aware (nested objects
    become ``<Nested>Recovered``; array-of-objects become ``list[...]``)."""
    if _is_object_field(field):
        target = _ref_vo(field, root)
        base = f'"{mirror_name(target)}"' if target is not None else "object"
        elem = f"{base} | None"
        return f"list[{elem}] | None" if fm.is_array(field) else elem
    if fm.is_array(field):
        return "list[str | None] | None"
    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        return "str | None"
    kind = fm.scalar_kind(field.sub_type)
    if kind in ("INT", "LONG"):
        return "int | None"
    if kind == "DOUBLE":
        return "float | None"
    if kind == "BOOLEAN":
        return "bool | None"
    return "str | None"


# =============================================================================
# Reachability
# =============================================================================


def reachable_vos(vo: MetaData, root: MetaData) -> list[MetaData]:
    """``vo`` + every value-object reachable through nested ``@objectRef`` fields, in
    stable BFS order, deduped by simple name (cycle-safe)."""
    out: list[MetaData] = []
    seen: set[str] = set()
    queue: list[MetaData] = [vo]
    while queue:
        cur = queue.pop(0)
        if cur.name in seen:
            continue
        seen.add(cur.name)
        out.append(cur)
        for f in fm.fields(cur):
            if _is_object_field(f):
                target = _ref_vo(f, root)
                if target is not None and target.name not in seen:
                    queue.append(target)
    return out


def has_nested(vo: MetaData, root: MetaData) -> bool:
    """True iff ``vo`` (or any reachable nested VO) has a nested-object field."""
    for cur in reachable_vos(vo, root):
        if any(_is_object_field(f) for f in fm.fields(cur)):
            return True
    return False


# =============================================================================
# Nested-aware mirror dataclasses
# =============================================================================


def nested_mirror_dataclasses(
    vo: MetaData, root: MetaData, payload_mirror: str
) -> list[str]:
    """Emit the nested-aware mirror dataclass for ``vo`` and every reachable nested VO
    (deduped). The payload mirror keeps the canonical ``<Template>Recovered`` name
    (``payload_mirror``) so the existing self-contained ``recover_<name>()`` initializer
    and the delegating path share ONE mirror type. The nested mirrors carry their own
    ``<VO>Recovered`` name. Returns source lines (blank-line separated)."""
    lines: list[str] = []
    for i, cur in enumerate(reachable_vos(vo, root)):
        if i > 0:
            lines.append("")
            lines.append("")
        name = payload_mirror if i == 0 else mirror_name(cur)
        lines.extend(_one_mirror(cur, root, name))
    return lines


def _one_mirror(vo: MetaData, root: MetaData, record_name: str) -> list[str]:
    base = (
        record_name[: -len("Recovered")]
        if record_name.endswith("Recovered")
        else record_name
    )
    lines: list[str] = [
        "@dataclass(frozen=True, slots=True)",
        f"class {record_name}:",
        f'    """Best-effort recovered twin of ``{base}`` — every field nullable',
        '    (``None`` where the value was lost or malformed)."""',
    ]
    field_lines = [
        f"    {f.name}: {_nested_mirror_type(f, root)} = None" for f in fm.fields(vo)
    ]
    lines.extend(field_lines or ["    pass"])
    return lines


# =============================================================================
# Mapper functions (assembled ValueObject graph -> typed nullable mirror graph)
# =============================================================================


def nested_mappers(
    vo: MetaData, root: MetaData, root_mapper_fn: str, root_mirror: str
) -> list[str]:
    """Emit one ``_from_<vo>_recovered(o)`` mapper per reachable VO (payload + nested,
    deduped). The ROOT mapper is overridden to the template-derived ``root_mapper_fn`` /
    ``root_mirror`` so it returns the canonically-named root mirror. Returns source
    lines (blank-line separated)."""
    lines: list[str] = []
    vos = reachable_vos(vo, root)
    for i, cur in enumerate(vos):
        if i > 0:
            lines.append("")
            lines.append("")
        fn = root_mapper_fn if i == 0 else _mapper_name(cur)
        mir = root_mirror if i == 0 else mirror_name(cur)
        lines.extend(_one_mapper(cur, root, fn, mir))
    return lines


def _one_mapper(
    vo: MetaData, root: MetaData, fn: str, mirror: str
) -> list[str]:
    lines: list[str] = [
        f'def {fn}(o: object | None) -> "{mirror} | None":',
        f"    \"\"\"Map an assembled ValueObject graph into a typed ``{mirror}`` mirror;"
        " null-tolerant.\"\"\"",
        "    if o is None:",
        "        return None",
        f"    return {mirror}(",
    ]
    for f in fm.fields(vo):
        lines.append(f"        {f.name}={_mapper_arg(f, root)},")
    lines.append("    )")
    return lines


def _mapper_arg(field: MetaData, root: MetaData) -> str:
    """The mirror-field initializer that reads ``field`` from the assembled object ``o``."""
    key = f'"{field.name}"'
    if _is_object_field(field):
        target = _ref_vo(field, root)
        if target is None:
            return "None  # unresolved @objectRef"
        fn = _mapper_name(target)
        if fm.is_array(field):
            return f"_map_object_list(_read_prop(o, {key}), {fn})"
        return f"{fn}(_read_prop(o, {key}))"

    # Enum / scalar / scalar-array: the runtime already coerced; read + light-coerce to
    # the mirror's nullable shape via the locally-defined _dlg_* readers.
    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        return f"_dlg_str(_read_prop(o, {key}))"
    if fm.is_array(field):
        return f"_dlg_str_list(_read_prop(o, {key}))"
    kind = fm.scalar_kind(field.sub_type)
    if kind in ("INT", "LONG"):
        return f"_dlg_int(_read_prop(o, {key}))"
    if kind == "DOUBLE":
        return f"_dlg_float(_read_prop(o, {key}))"
    if kind == "BOOLEAN":
        return f"_dlg_bool(_read_prop(o, {key}))"
    return f"_dlg_str(_read_prop(o, {key}))"


# =============================================================================
# Used-helper scoping + the shared helper block
# =============================================================================


def used_helpers(vo: MetaData, root: MetaData) -> set[str]:
    """The generated-helper names the mappers for ``vo`` (+ reachable nested VOs)
    actually reference. ``_read_prop`` is always present once any mapper is emitted."""
    used: set[str] = {"_read_prop"}
    for cur in reachable_vos(vo, root):
        for f in fm.fields(cur):
            if _is_object_field(f):
                if fm.is_array(f):
                    used.add("_map_object_list")
                continue
            if f.sub_type == fc.FIELD_SUBTYPE_ENUM:
                used.add("_dlg_str")
            elif fm.is_array(f):
                used.add("_dlg_str_list")
            else:
                kind = fm.scalar_kind(f.sub_type)
                if kind in ("INT", "LONG"):
                    used.add("_dlg_int")
                elif kind == "DOUBLE":
                    used.add("_dlg_float")
                elif kind == "BOOLEAN":
                    used.add("_dlg_bool")
                else:
                    used.add("_dlg_str")
    return used


# Each helper: name -> source block (lines).
_HELPER_BLOCKS: dict[str, list[str]] = {
    "_read_prop": [
        "def _read_prop(o: object | None, name: str) -> object | None:",
        '    """Read a property from an assembled backing object, mirroring the',
        "    MetaField get SPI (``ValueObject.get(name)`` else plain-attribute access).",
        '    Keeps the mappers reflection-free + backing-agnostic."""',
        "    if o is None:",
        "        return None",
        '    getter = getattr(o, "get", None)',
        "    if callable(getter):",
        "        return getter(name)",
        "    return getattr(o, name, None)",
    ],
    "_map_object_list": [
        "def _map_object_list(v: object | None, fn) -> list | None:",
        '    """Map each element of an assembled array via ``fn``; non-list -> None."""',
        "    if not isinstance(v, list):",
        "        return None",
        "    return [fn(e) for e in v]",
    ],
    "_dlg_str": [
        "def _dlg_str(v: object | None) -> str | None:",
        "    return None if v is None else str(v)",
    ],
    "_dlg_int": [
        "def _dlg_int(v: object | None) -> int | None:",
        "    if v is None:",
        "        return None",
        "    try:",
        "        return int(v)  # type: ignore[arg-type, call-overload]",
        "    except (TypeError, ValueError):",
        "        return None",
    ],
    "_dlg_float": [
        "def _dlg_float(v: object | None) -> float | None:",
        "    if v is None:",
        "        return None",
        "    try:",
        "        return float(v)  # type: ignore[arg-type]",
        "    except (TypeError, ValueError):",
        "        return None",
    ],
    "_dlg_bool": [
        "def _dlg_bool(v: object | None) -> bool | None:",
        "    if v is None:",
        "        return None",
        "    if isinstance(v, bool):",
        "        return v",
        '    return str(v).lower() == "true"',
    ],
    "_dlg_str_list": [
        "def _dlg_str_list(v: object | None) -> list | None:",
        "    if not isinstance(v, list):",
        "        return None",
        "    return [None if e is None else str(e) for e in v]",
    ],
}

# Stable emission order (deterministic output).
_HELPER_ORDER: tuple[str, ...] = (
    "_read_prop",
    "_map_object_list",
    "_dlg_str",
    "_dlg_int",
    "_dlg_float",
    "_dlg_bool",
    "_dlg_str_list",
)


def delegate_helpers(used: set[str]) -> list[str]:
    """The shared helper block the generated mappers rely on, scoped to ``used`` and
    emitted in stable order. Returns source lines (blank-line separated)."""
    lines: list[str] = [
        "# ---- runtime-delegating recover helpers (generated) ----"
    ]
    for name in _HELPER_ORDER:
        if name in used:
            lines.append("")
            lines.append("")
            lines.extend(_HELPER_BLOCKS[name])
    return lines
