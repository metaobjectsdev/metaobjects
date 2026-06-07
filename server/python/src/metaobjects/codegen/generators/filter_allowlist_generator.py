"""FastAPI filter-allowlist codegen — one ``<entity_snake>_filter_allowlist.py``
per writable entity (``source.rdb`` with ``@kind="table"``).

FR-009 §3.5 (cross-port). Emits a per-entity static allowlist:

* ``<ENTITY>_FILTER_FIELDS: frozenset[str]`` — the field names that are
  filterable (gate against ``invalid_filter_field``).
* ``<ENTITY>_FILTER_OPS_BY_FIELD: dict[str, frozenset[str]]`` — the
  per-field operator vocabulary (gate against ``invalid_filter_op``).

Authoring contract: only fields with ``@filterable: true`` appear in the
allowlist. If no field is marked filterable, the file is still emitted (with
empty frozensets) so the generated router can unconditionally delegate to
it without conditional codegen branching.

Operators-per-subtype mapping (FR-009 §5, identical across ports):

* ``string`` / ``enum`` → ``eq, ne, in, like, isNull``
* ``uuid`` → ``eq, ne, in, isNull``  (no ``like`` — not a substring type, no ordering)
* ``int / long / float / double / decimal / currency / date / timestamp / time``
  → ``eq, ne, gt, gte, lt, lte, in, isNull``
* ``boolean`` → ``eq, isNull``

``object`` fields are skipped — they have no SQL column surface that filters
can target.

Mirrors the Java ``SpringFilterAllowlistGenerator`` + Kotlin
``KotlinFilterAllowlistGenerator`` + C# allowlist emission. View kinds
(``view`` / ``materializedView`` / ``storedProc`` / ``tableFunction``) get
no allowlist — they share the "no router emitted" gate with
``router_generator``.
"""
from __future__ import annotations

from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator, per_entity
from metaobjects.codegen.instance_artifacts import emits_instance_artifacts
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import SOURCE_KIND_TABLE
from metaobjects.shared.base_types import TYPE_SOURCE
from metaobjects.shared.separators import PACKAGE_SEP


# Operator sets — preserve insertion order (Python dict order == spec order).
_OPS_STRING: tuple[str, ...] = ("eq", "ne", "in", "like", "isNull")
# uuid: identity-comparison only — no `like` (not a substring type), no ordering.
_OPS_UUID: tuple[str, ...] = ("eq", "ne", "in", "isNull")
_OPS_NUMERIC: tuple[str, ...] = ("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull")
_OPS_BOOLEAN: tuple[str, ...] = ("eq", "isNull")


def _effective_fqn(entity: MetaObject) -> str:
    """``package::name``, resolving package from the nearest ancestor that carries
    one. Mirror of the router generator's helper of the same name."""
    pkg = entity.package
    parent = entity.parent
    while pkg is None and parent is not None:
        pkg = parent.package
        parent = parent.parent
    return f"{pkg}{PACKAGE_SEP}{entity.name}" if pkg else entity.name


def _snake_case(name: str) -> str:
    """``Author`` → ``author``; ``AuthorBrief`` → ``author_brief``. Mirror of
    the router generator's helper of the same name."""
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _primary_source_rdb(entity: MetaObject) -> MetaSource | None:
    """Return the entity's ``source.rdb`` child (own only), or ``None``."""
    for c in entity.own_children():
        if c.type == TYPE_SOURCE and isinstance(c, MetaSource):
            return c
    return None


def ops_for_subtype_ordered(sub_type: str | None) -> tuple[str, ...]:
    """Return the operator tuple for ``sub_type`` per the FR-009 §5 matrix.

    Ordered (canonical operator order), unlike the loader's
    ``validation_passes.ops_for_subtype`` which returns an order-free
    ``frozenset``. This is the single ordered source the codegen
    filter-allowlist emit + the cross-port ``field.filter-ops`` conformance
    capability consume.

    Returns an empty tuple for subtypes outside the FR-009 vocabulary
    (defensive — the allowlist effectively becomes a "field is unknown" gate
    when the subtype is unrecognized).

    Module-level back-compat shim; the override seam is
    :meth:`FilterAllowlistGenerator._ops_for_field`.
    """
    if sub_type is None:
        return ()
    if sub_type in (fc.FIELD_SUBTYPE_STRING, fc.FIELD_SUBTYPE_ENUM):
        return _OPS_STRING
    if sub_type == fc.FIELD_SUBTYPE_UUID:
        return _OPS_UUID
    if sub_type in (
        fc.FIELD_SUBTYPE_INT,
        fc.FIELD_SUBTYPE_LONG,
        fc.FIELD_SUBTYPE_FLOAT,
        fc.FIELD_SUBTYPE_DOUBLE,
        fc.FIELD_SUBTYPE_DECIMAL,
        fc.FIELD_SUBTYPE_CURRENCY,
        fc.FIELD_SUBTYPE_DATE,
        fc.FIELD_SUBTYPE_TIMESTAMP,
        fc.FIELD_SUBTYPE_TIME,
    ):
        return _OPS_NUMERIC
    if sub_type == fc.FIELD_SUBTYPE_BOOLEAN:
        return _OPS_BOOLEAN
    return ()


def _is_filterable(field: MetaField) -> bool:
    """True iff ``field`` carries ``@filterable: true`` as a metadata attribute.

    Accepts a real boolean ``True`` or the string ``"true"`` (case-insensitive),
    matching the Java/Kotlin/C# tolerance for either YAML-bool or raw-string
    value forms.
    """
    raw = field.attr(fc.FIELD_ATTR_FILTERABLE)
    if raw is True:
        return True
    if isinstance(raw, str):
        return raw.lower() == "true"
    return False


def _compute_filterable_ops(entity: MetaObject) -> dict[str, tuple[str, ...]]:
    """Module-level back-compat wrapper. Delegates to a default
    :class:`FilterAllowlistGenerator`."""
    return FilterAllowlistGenerator()._compute_filterable_ops(entity)


class FilterAllowlistGenerator:
    """``object.entity`` + ``source.rdb @kind="table"`` → one
    ``<entity_snake>_filter_allowlist.py`` per writable entity (FR-009 §3.5).

    EXTENSION SEAM (open-for-extension). Adopters subclass this and override one of
    the protected hooks to customize the emitted allowlist without forking. The
    factory ``filter_allowlist_generator()`` and the module-level
    ``render_filter_allowlist()`` both delegate to a default instance, so the
    default suite stays byte-identical.

    Override points:

    * ``_ops_for_field(field)`` — the operator tuple a filterable field is allowed
      (defaults to the FR-009 §5 per-subtype matrix). Override to widen/narrow the
      operator vocabulary for a custom field shape.
    * ``_emit_constants(fields_const, ops_const, ops_by_field)`` — the emitted
      ``frozenset`` / ``dict`` literal lines.
    * ``render_filter_allowlist(entity)`` — the whole module (last resort).

    Skips entities without a ``source.rdb`` child and read-only kinds
    (view / materializedView / storedProc / tableFunction) — same gate as
    ``RouterGenerator``, so the two generators emit in lock-step.
    """

    name = "filter-allowlist-generator"

    def _ops_for_field(self, field: MetaField) -> tuple[str, ...]:
        """The operator tuple allowed for ``field`` (FR-009 §5 per-subtype matrix by
        default). Override to customize the per-field operator vocabulary; returning
        an empty tuple excludes the field from the allowlist."""
        return ops_for_subtype_ordered(field.sub_type)

    def _compute_filterable_ops(
        self, entity: MetaObject
    ) -> dict[str, tuple[str, ...]]:
        """Build the ``{field_name: op_tuple}`` map for ``entity`` (own + inherited
        effective fields). Only fields with ``@filterable: true`` are included;
        object fields and fields whose ``_ops_for_field`` yields no operators are
        skipped. Preserves declaration order so the emitted source is deterministic."""
        out: dict[str, tuple[str, ...]] = {}
        for f in entity.fields():
            if f.sub_type == fc.FIELD_SUBTYPE_OBJECT:
                continue
            if not _is_filterable(f):
                continue
            ops = self._ops_for_field(f)
            if not ops:
                continue
            out[f.name] = ops
        return out

    def _emit_constants(
        self,
        fields_const: str,
        ops_const: str,
        ops_by_field: dict[str, tuple[str, ...]],
    ) -> list[str]:
        """The ``<ENTITY>_FILTER_FIELDS`` frozenset + ``<ENTITY>_FILTER_OPS_BY_FIELD``
        dict literal lines. Override to change the emitted data-structure shape."""
        lines: list[str] = []
        if not ops_by_field:
            lines.append(f"{fields_const}: frozenset[str] = frozenset()")
            lines.append("")
            lines.append(f"{ops_const}: dict[str, frozenset[str]] = {{}}")
        else:
            lines.append(f"{fields_const}: frozenset[str] = frozenset({{")
            for name in ops_by_field:
                lines.append(f'    "{name}",')
            lines.append("})")
            lines.append("")
            lines.append(f"{ops_const}: dict[str, frozenset[str]] = {{")
            for name, ops in ops_by_field.items():
                ops_literal = ", ".join(f'"{op}"' for op in ops)
                lines.append(f'    "{name}": frozenset({{{ops_literal}}}),')
            lines.append("}")
        return lines

    def render_filter_allowlist(self, entity: MetaObject) -> str | None:
        """Render the filter allowlist module for ``entity`` (or ``None`` to skip).

        Returns ``None`` for entities without a ``source.rdb`` child and for
        read-only kinds (``view`` / ``materializedView`` / ``storedProc`` /
        ``tableFunction``) — these match the router generator's "no router"
        gate, so emitting an allowlist would be pure noise.
        """
        if not emits_instance_artifacts(entity):
            return None
        src = _primary_source_rdb(entity)
        if src is None:
            return None
        if src.effective_kind() != SOURCE_KIND_TABLE:
            return None

        short_name = entity.name
        upper = short_name.upper()
        fields_const = f"{upper}_FILTER_FIELDS"
        ops_const = f"{upper}_FILTER_OPS_BY_FIELD"

        ops_by_field = self._compute_filterable_ops(entity)

        parts: list[str] = []
        parts.append(
            generated_header(short_name, _effective_fqn(entity)).rstrip() + "\n"
            + f'"""GENERATED — per-entity FR-009 filter allowlist for {short_name}.\n\n'
            f"{fields_const} lists the filterable field names; {ops_const}\n"
            f'constrains the operator vocabulary for each field by its subtype."""\n'
        )
        parts.append("from __future__ import annotations")
        parts.append("")
        parts.extend(self._emit_constants(fields_const, ops_const, ops_by_field))
        parts.append("")
        return "\n".join(parts)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        def emit(entity: MetaObject, _c: GenContext) -> list[EmittedFile]:
            source = self.render_filter_allowlist(entity)
            if source is None:
                return []
            snake = _snake_case(entity.name)
            return [
                EmittedFile(
                    path=f"{snake}_filter_allowlist.py",
                    content=ruff_format(source),
                )
            ]

        return per_entity(emit)(ctx)


def render_filter_allowlist(entity: MetaObject) -> str | None:
    """Module-level back-compat wrapper. Delegates to a default
    :class:`FilterAllowlistGenerator`. Subclass it to customize."""
    return FilterAllowlistGenerator().render_filter_allowlist(entity)


def filter_allowlist_generator() -> Generator:
    """Generator factory: ``object.entity`` + ``source.rdb @kind="table"`` → one
    ``<entity_snake>_filter_allowlist.py`` per writable entity.

    Returns a :class:`FilterAllowlistGenerator` (subclassable extension seam)."""
    return FilterAllowlistGenerator()
