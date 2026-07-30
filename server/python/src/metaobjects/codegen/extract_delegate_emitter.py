"""FR-010 nested-codegen-gap — the runtime-DELEGATING extract emitter (Python).

The self-contained ``extract_<name>(text)`` path (``extract_schema_emitter`` + the
baked ``ExtractSchema``) covers scalars / enums / scalar-arrays but leaves
nested-object and array-of-object components ``None`` — the historical FR-010 codegen
gap. This module emits the additive *delegating* entry that CLOSES that gap by
wrapping the runtime extract:

    extract_<name>_with_loader(root, text, opts=None) -> ExtractionResult[<Name>Extracted]

It resolves this payload's ``MetaObject`` from the supplied loaded ``MetaRoot`` by its
baked simple name (``PAYLOAD_NAME``), delegates to ``extract_object`` in
:mod:`metaobjects.meta.core.object.object_extract` (which assembles the FULL nested
object graph reflection-free via the Phase A object model — ``MetaObject.new_instance()``
+ the ``MetaField`` set-by-name SPI), then maps the assembled ``ValueObject`` graph into
the typed nullable mirror graph via generated ``_from_<vo>_extracted(o)`` mapper
functions (payload + every reachable nested VO, deduped).

This is the codegen-wrapping-runtime pattern (a generated DAO calling the
dynamic-metadata runtime), mirroring the Java / Kotlin / TS pilots. The generated
mappers read the assembled graph through a tiny ``_read_prop`` helper that mirrors the
``MetaField`` get SPI (``ValueObject.get(name)`` else plain-attribute access), so the
emitted code stays self-sufficient and reflection-free.

Bounded by the cross-port ``MAX_NEST_DEPTH`` via the runtime — codegen here only mirrors
the runtime's resolved object graph, so depth/cycle guarding lives in ``object_extract``.
The emitter dedupes mirrors/mappers by ``resolution_key()`` (the package-qualified FQN,
cycle-safe) — NOT the bare VO ``name``, which would silently collapse two same-short-name
value-objects from different packages into one (ADR-0044, #228). A bare-name collision
resolves to a package-qualified emitted name via the shared
:func:`~metaobjects.codegen.collision_names.assign_nested_names` pass (see
:func:`build_name_map`) — the SAME naming pass the payload-record tier
(``payload_vo_generator``) runs, so this tier's names never diverge from the payload
module's own.
"""
from __future__ import annotations

from metaobjects.codegen import fr010_field_mapping as fm
from metaobjects.codegen.collision_names import assign_nested_names
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming_refs import resolve_object_ref
from metaobjects.shared.separators import PACKAGE_SEP


def _pkg_of(node: MetaData) -> str:
    """The effective package of an object — its ``resolution_key()`` minus the
    trailing ``::<name>`` ("" for a root-level object). Duplicated (not imported) to
    match the existing per-generator convention — ``payload_vo_generator.py`` and
    ``render_helper_generator.py`` each carry their own identical copy."""
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


def ref_vo(field: MetaData, root: MetaData) -> MetaData | None:
    """The ``@objectRef`` target VO for a nested-object field, or ``None`` when
    unresolvable.

    ADR-0042 (#228) — resolves via the canonical `resolve_object_ref` package-local
    contract: an FQN ref resolves EXACTLY; a bare ref resolves in the DECLARING
    field's own package first, else a root-level object. NO bare-tail short-name
    fallback — that pattern (matching an FQN ref by its trailing simple-name segment
    against ANY same-named object root-wide) is the #219/ADR-0042-banned "wrong
    node" bug: under a cross-package short-name collision it silently binds
    whichever same-named object happens to load first, regardless of which package
    the ref actually pointed at. *referrer_pkg* is the field's OWN declaring
    package (which differs from the VO's when the field is inherited via `extends`
    from an abstract VO in another package) — mirrors payload_vo_generator's
    `_resolve_object_field_type`."""
    ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
    if not isinstance(ref, str) or not ref:
        return None
    referrer_pkg = _pkg_of(field.parent) if field.parent is not None else ""
    return resolve_object_ref(root, ref, referrer_pkg)


def _is_object_field(field: MetaData) -> bool:
    """True iff the field is a nested object reference (``field.object`` — distinct
    from the string-backed ``field.enum``, treated as a scalar)."""
    return field.sub_type == fc.FIELD_SUBTYPE_OBJECT


def mirror_name(vo: MetaData, name_map: dict[str, str]) -> str:
    """The extracted-mirror dataclass name for a value-object
    (``<Base>Extracted``) — ADR-0044 (#228) collision-scoped: *base* is the bare
    ``vo.name`` unless a cross-package bare-name collision requires the
    package-qualified derived form (see :func:`build_name_map`)."""
    base = name_map.get(vo.resolution_key(), vo.name)
    return f"{base}Extracted"


def _mapper_name(vo: MetaData, name_map: dict[str, str]) -> str:
    """The mapper function name for a value-object (``_from_<base_snake>_extracted``)
    — *base* per :func:`mirror_name`."""
    base = name_map.get(vo.resolution_key(), vo.name)
    return f"_from_{_snake(base)}_extracted"


def root_mapper_name(template_name: str) -> str:
    """The root mapper's name — derived from the TEMPLATE (so it returns the
    canonically-named ``<Template>Extracted`` mirror)."""
    return f"_from_{_snake(template_name)}_extracted"


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


def _nested_mirror_type(field: MetaData, root: MetaData, name_map: dict[str, str]) -> str:
    """The nullable mirror annotation for one field — nested-aware (nested objects
    become ``<Nested>Extracted``; array-of-objects become ``list[...]``)."""
    if _is_object_field(field):
        target = ref_vo(field, root)
        base = f'"{mirror_name(target, name_map)}"' if target is not None else "object"
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
    stable BFS order, deduped by ``resolution_key()`` (cycle-safe).

    ADR-0044 (#228) — deduping by the bare ``name`` (pre-fix) silently DROPPED a
    second cross-package value-object sharing the first one's bare short name (e.g.
    ``acme::alpha::Note`` + ``acme::beta::Note``): once the first ``Note`` was seen,
    the second's bare name matched ``seen`` and it was never queued/emitted — a
    silent shape loss, not merely a naming cosmetic. ``resolution_key()`` is the
    package-qualified FQN, so two same-short-name VOs from different packages are
    two distinct keys and both survive the walk."""
    out: list[MetaData] = []
    seen: set[str] = set()
    queue: list[MetaData] = [vo]
    while queue:
        cur = queue.pop(0)
        key = cur.resolution_key()
        if key in seen:
            continue
        seen.add(key)
        out.append(cur)
        for f in fm.fields(cur):
            if _is_object_field(f):
                target = ref_vo(f, root)
                if target is not None and target.resolution_key() not in seen:
                    queue.append(target)
    return out


def has_nested(vo: MetaData, root: MetaData) -> bool:
    """True iff ``vo`` (or any reachable nested VO) has a nested-object field."""
    for cur in reachable_vos(vo, root):
        if any(_is_object_field(f) for f in fm.fields(cur)):
            return True
    return False


def build_name_map(vo: MetaData, root: MetaData) -> dict[str, str]:
    """ADR-0044 (#228) — the collision-scoped BASE name map for ``vo``'s reachable
    nested-VO closure, keyed by ``resolution_key()``. ``vo`` itself (the PRIMARY —
    named after the enclosing template/payload, never its own bare name) is
    excluded from the collision domain, mirroring payload_vo_generator's
    `_collect_nested_closure` (which seeds ``seen`` with the primary's own key for
    the identical reason).

    Reuses the SAME shared :func:`~metaobjects.codegen.collision_names.assign_nested_names`
    pass the payload-record tier runs, so a nested VO's derived BASE here agrees
    exactly with the payload module's own emitted class name (modulo the
    ``Payload``/``Extracted`` suffix each tier applies on top) — the extractor's
    imports and the payload module's declarations can never diverge."""
    primary_key = vo.resolution_key()
    closure: dict[str, MetaData] = {
        cur.resolution_key(): cur
        for cur in reachable_vos(vo, root)
        if cur.resolution_key() != primary_key
    }
    return assign_nested_names(closure)


# =============================================================================
# Nested-aware mirror dataclasses
# =============================================================================


def nested_mirror_dataclasses(
    vo: MetaData, root: MetaData, payload_mirror: str, name_map: dict[str, str]
) -> list[str]:
    """Emit the nested-aware mirror dataclass for ``vo`` and every reachable nested VO
    (deduped). The payload mirror keeps the canonical ``<Template>Extracted`` name
    (``payload_mirror``) so the existing self-contained ``extract_<name>()`` initializer
    and the delegating path share ONE mirror type. The nested mirrors carry their own
    ADR-0044 (#228) collision-scoped ``<Base>Extracted`` name (*name_map*, from
    :func:`build_name_map`). Returns source lines (blank-line separated)."""
    lines: list[str] = []
    for i, cur in enumerate(reachable_vos(vo, root)):
        if i > 0:
            lines.append("")
            lines.append("")
        name = payload_mirror if i == 0 else mirror_name(cur, name_map)
        lines.extend(_one_mirror(cur, root, name, name_map))
    return lines


def _one_mirror(
    vo: MetaData, root: MetaData, record_name: str, name_map: dict[str, str]
) -> list[str]:
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
        f"    {f.name}: {_nested_mirror_type(f, root, name_map)} = None"
        for f in fm.fields(vo)
    ]
    lines.extend(field_lines or ["    pass"])
    return lines


# =============================================================================
# Mapper functions (assembled ValueObject graph -> typed nullable mirror graph)
# =============================================================================


def nested_mappers(
    vo: MetaData,
    root: MetaData,
    root_mapper_fn: str,
    root_mirror: str,
    name_map: dict[str, str],
) -> list[str]:
    """Emit one ``_from_<base>_extracted(o)`` mapper per reachable VO (payload +
    nested, deduped). The ROOT mapper is overridden to the template-derived
    ``root_mapper_fn`` / ``root_mirror`` so it returns the canonically-named root
    mirror. Nested mappers use the ADR-0044 (#228) collision-scoped *name_map* (from
    :func:`build_name_map`). Returns source lines (blank-line separated)."""
    lines: list[str] = []
    vos = reachable_vos(vo, root)
    for i, cur in enumerate(vos):
        if i > 0:
            lines.append("")
            lines.append("")
        fn = root_mapper_fn if i == 0 else _mapper_name(cur, name_map)
        mir = root_mirror if i == 0 else mirror_name(cur, name_map)
        lines.extend(_one_mapper(cur, root, fn, mir, name_map))
    return lines


def _one_mapper(
    vo: MetaData, root: MetaData, fn: str, mirror: str, name_map: dict[str, str]
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
        lines.append(f"        {f.name}={_mapper_arg(f, root, name_map)},")
    lines.append("    )")
    return lines


def _mapper_arg(field: MetaData, root: MetaData, name_map: dict[str, str]) -> str:
    """The mirror-field initializer that reads ``field`` from the assembled object ``o``."""
    key = f'"{field.name}"'
    if _is_object_field(field):
        target = ref_vo(field, root)
        if target is None:
            return "None  # unresolved @objectRef"
        fn = _mapper_name(target, name_map)
        if fm.is_array(field):
            return f"_map_object_list(_read_prop(o, {key}), {fn})"
        return f"{fn}(_read_prop(o, {key}))"

    # Enum / scalar / scalar-array: the runtime already coerced; read + light-coerce to
    # the mirror's nullable shape via the locally-defined _dlg_* readers.
    # ARRAY is checked BEFORE the scalar-enum branch: an enum ARRAY must route through
    # the string-LIST reader, not the scalar enum reader — otherwise the list collapses
    # to a single stringified scalar (the cross-port "enum-before-isArray" ordering bug).
    if fm.is_array(field):
        return f"_dlg_str_list(_read_prop(o, {key}))"
    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        return f"_dlg_str(_read_prop(o, {key}))"
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
            if fm.is_array(f):
                # ARRAY before scalar-enum — an enum array uses the string-LIST reader
                # (mirrors the _mapper_arg ordering; avoids the collapse-to-scalar bug).
                used.add("_dlg_str_list")
            elif f.sub_type == fc.FIELD_SUBTYPE_ENUM:
                used.add("_dlg_str")
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
        "# ---- runtime-delegating extract helpers (generated) ----"
    ]
    for name in _HELPER_ORDER:
        if name in used:
            lines.append("")
            lines.append("")
            lines.extend(_HELPER_BLOCKS[name])
    return lines
