"""Per-object physical database name constants — one ``<entity_snake>_names.py``
per object with a declared (or inherited) primary ``source.rdb`` (#248).

Mirrors the shipped C# ``NamesGenerator`` / ``CSharpNaming.ResolveObjectNames``
and the Kotlin ``KotlinNamesGenerator`` member for member, in Python's idiom:
module-level ``Final`` SCALARS rather than a dict of dicts — mypy narrows a
``Final[str]`` to a literal type, while a dict lookup is merely ``str`` — then a
``Final[dict[str, str]]`` map whose values REFERENCE those constants rather than
repeating the literals.

Participation derives from a declared/inherited primary source, never from the
object subtype (#248): an ``object.value`` (no source, ever) and a sourceless
``object.projection`` both resolve to no artifact here, the same as any other
consumer of :mod:`metaobjects.source_resolution` — THE resolver for
"which ``source.rdb`` is this object's primary", so this generator does not
hand-roll a sixth copy of that predicate.

The Python surface this artifact backs is a bare Pydantic class with no ORM
binding, so before this generator existed there was no route at all from a
model to the column a row actually lands in — the one place that answer lives
was :func:`metaobjects.naming.resolve_column_name`, called directly. This is
that same resolver's answer, materialized as importable constants.
"""
from __future__ import annotations

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator, per_entity
from metaobjects.source_resolution import primary_rdb_source
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.naming import resolve_column_name, to_snake_case


def _effective_fqn(entity: MetaObject) -> str:
    """``package::name`` via the canonical :meth:`MetaData.resolution_key`.
    Mirror of the filter-allowlist / router generators' helper of the same
    name."""
    return entity.resolution_key()


def _member(field_name: str) -> str:
    """The SCREAMING_SNAKE member-name segment for a field name — the same
    camelCase-to-snake_case algorithm :func:`metaobjects.naming.to_snake_case`
    already applies for the ``snake_case`` column-naming strategy, upper-cased.
    ``createdAt`` -> ``CREATED_AT``."""
    return to_snake_case(field_name).upper()


def names_artifact_super_of(entity: MetaObject) -> MetaObject | None:
    """The nearest ancestor of ``entity`` carrying a names module of its own, or None.

    Walks PAST an ancestor with nothing to contribute — an abstract marker with no
    fields and no source emits no module, so there is nothing to import and the search
    continues upward rather than stopping at a name that does not exist.
    """
    cur = entity.super_data
    while cur is not None:
        if isinstance(cur, MetaObject) and (
            cur.own_fields() or primary_rdb_source(cur) is not None
        ):
            return cur
        cur = cur.super_data
    return None


def render_names(entity: MetaObject, strategy: str, *, fragment: bool = False) -> str | None:
    """Render the names module for ``entity``, or ``None`` when it declares (and
    inherits) no primary ``source.rdb`` at all (#248).

    ``strategy`` is ``GenConfig``'s column-naming-strategy field — the same value
    :func:`metaobjects.naming.resolve_column_name` applies to any field with no
    explicit ``@column``.

    ``fragment=True`` renders the FRAGMENT form: an abstract base that a sourced object
    extends, carrying the columns it declares and NO physical name — it has none and
    must never acquire one. That form is separate on purpose, and the separation is the
    #248 rule intact rather than weakened: "has a primary source" still decides database
    participation, so an ``object.value`` carrying fields renders nothing as it always
    has. A fragment is rendered only for an object REACHED from a participant by walking
    ``extends`` upward — the only context in which its fields are columns at all.
    """
    src = primary_rdb_source(entity)
    if fragment:
        if not entity.own_fields():
            # An abstract marker has nothing to import; an empty module would put a name
            # in the package that says nothing.
            return None
    elif src is None:
        return None

    upper = entity.name.upper()

    # Python has no static inheritance to lean on, so an artifact with a super
    # re-exports the inherited constants BY REFERENCE rather than restating their
    # literals — one spelling of each physical name, which is the whole guarantee. (C#
    # and Java use real class inheritance; the emitted shape differs per language, the
    # guarantee does not.)
    super_obj = names_artifact_super_of(entity)
    super_upper = None if super_obj is None else super_obj.name.upper()

    # ADR-0039: fields() RESOLVES — an inherited field and an inherited @column
    # both must appear here, or the constant disagrees with what the runtime
    # actually binds. Sorted by field name so output depends on the model, not
    # on child declaration order.
    rows = sorted(
        ((f.name, resolve_column_name(f, strategy)) for f in entity.fields()),
        key=lambda row: row[0],
    )
    # ADR-0039's sanctioned own-accessor use: what this module DECLARES as a literal.
    # The rest are references to the base's constants.
    own_names = {f.name for f in entity.own_fields()}
    inherited = [] if super_upper is None else [r for r in rows if r[0] not in own_names]
    declared = rows if super_upper is None else [r for r in rows if r[0] in own_names]

    # Two fields whose constant-member forms collide would silently lose one
    # constant to the other (the later assignment wins) rather than fail loud.
    # Mirrors the C#/Kotlin ports' guard — fail here, naming the model, rather
    # than emitting a module with a lost constant.
    #
    # Checked over the WHOLE field set (``rows``), never just what this module declares:
    # once a child stopped restating its inherited constants, an own-only check could no
    # longer see a collision that spans the ``extends`` boundary — and here the two
    # constants land in the SAME module (the child re-exports the inherited one under its
    # own name), so the later assignment would silently win.
    by_member: dict[str, list[str]] = {}
    for name, _column in rows:
        by_member.setdefault(_member(name), []).append(name)
    dupe = next(
        ((member, names) for member, names in by_member.items() if len(names) > 1),
        None,
    )
    if dupe is not None:
        member, names = dupe
        raise ValueError(
            f"{entity.name}: fields {', '.join(names)} all yield the constant "
            f'member "{member}". Rename one, or give it an explicit @column.'
        )

    lines: list[str] = [
        generated_header(entity.name, _effective_fqn(entity)).rstrip() + "\n"
        + f'"""GENERATED — per-object physical database names for '
        f'{entity.name} (#248)."""\n',
        "from __future__ import annotations",
        "",
        "from typing import Final",
        "",
    ]
    # A fragment has no source, so no KIND/NAME/SCHEMA/READ_ONLY. An object that INHERITS
    # its source (a TPH subtype sharing its base's single table) takes them from the base
    # module by reference rather than restating them. Reference identity of the resolved
    # source, not equality of the resolved strings: the question is structural — did this
    # object declare a source, or is it using its parent's?
    inherits_source = (
        src is not None
        and super_obj is not None
        and primary_rdb_source(super_obj) is src
    )

    if super_obj is not None and super_upper is not None:
        # EVERY name this module references must be imported, the source-level constants
        # included — the per-field members alone left an inherits_source module raising
        # NameError on import, which is why the gate for this actually imports the module
        # rather than only reading its text.
        members = {
            f"{super_upper}_{_member(n)}_{suffix}"
            for n, _c in inherited
            for suffix in ("FIELD", "COLUMN")
        }
        if not fragment and inherits_source:
            members |= {f"{super_upper}_KIND", f"{super_upper}_NAME", f"{super_upper}_READ_ONLY"}
            assert src is not None
            if src.schema():
                members.add(f"{super_upper}_SCHEMA")
        if members:
            lines.append(
                f"from .{_snake_case(super_obj.name)}_names import (\n"
                + "".join(f"    {m},\n" for m in sorted(members))
                + ")"
            )
            lines.append("")
    if not fragment:
        assert src is not None  # narrowed by the early return above
        if inherits_source:
            lines.append(f"{upper}_KIND: Final[str] = {super_upper}_KIND")
            lines.append(f"{upper}_NAME: Final[str] = {super_upper}_NAME")
            if src.schema():
                lines.append(f"{upper}_SCHEMA: Final[str] = {super_upper}_SCHEMA")
            lines.append(f"{upper}_READ_ONLY: Final[bool] = {super_upper}_READ_ONLY")
        else:
            lines.append(f'{upper}_KIND: Final[str] = "{src.effective_kind()}"')
            lines.append(f'{upper}_NAME: Final[str] = "{src.physical_name()}"')
            # Omitted entirely when undeclared — never emitted as `None` / a literal
            # empty string, which would read as "declared blank" rather than
            # "undeclared".
            schema = src.schema()
            if schema:
                lines.append(f'{upper}_SCHEMA: Final[str] = "{schema}"')
            lines.append(f"{upper}_READ_ONLY: Final[bool] = {src.is_read_only()}")
        lines.append("")
    for name, column in declared:
        member = _member(name)
        lines.append(f'{upper}_{member}_FIELD: Final[str] = "{name}"')
        lines.append(f'{upper}_{member}_COLUMN: Final[str] = "{column}"')
    for name, _column in inherited:
        member = _member(name)
        lines.append(f"{upper}_{member}_FIELD: Final[str] = {super_upper}_{member}_FIELD")
        lines.append(f"{upper}_{member}_COLUMN: Final[str] = {super_upper}_{member}_COLUMN")
    lines.append("")
    # Stays COMPLETE — every field, inherited included — because it is the lookup surface,
    # and a miss on an inherited field is exactly the fallback-to-literal this artifact
    # removes. It repeats no LITERAL: an inherited entry's value is this module's
    # re-exported reference to the base's own constant.
    lines.append(f"{upper}_COLUMNS_BY_FIELD: Final[dict[str, str]] = {{")
    for name, _column in rows:
        member = _member(name)
        lines.append(f'    "{name}": {upper}_{member}_COLUMN,')
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


class NamesGenerator:
    """``object.entity`` (or any object) + a declared/inherited primary
    ``source.rdb`` -> one ``<entity_snake>_names.py`` per object (#248)."""

    name = "names"

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        emitted: set[str] = set()

        def one(entity: MetaObject, *, fragment: bool) -> list[EmittedFile]:
            source = render_names(entity, ctx.config.column_naming, fragment=fragment)
            if source is None:
                return []
            emitted.add(entity.resolution_key())
            return [
                EmittedFile(
                    path=f"{_snake_case(entity.name)}_names.py",
                    content=ruff_format(source),
                )
            ]

        # Pass 1 — every matched object that participates in the database (#248).
        files = per_entity(lambda e, _c: one(e, fragment=False))(ctx)

        # Pass 2 — the abstract bases those participants EXTEND, each carrying the
        # columns it declares so a child states them once rather than restating its
        # parent's. Reached by walking UP from a participant, never by scanning for
        # abstracts: that is what keeps #248 intact.
        for entity in ctx.entities:
            if entity.resolution_key() not in emitted:
                continue
            sup = names_artifact_super_of(entity)
            while sup is not None:
                if sup.resolution_key() in emitted:
                    break  # already emitted, and so is everything above it
                files += one(sup, fragment=True)
                sup = names_artifact_super_of(sup)
        return files


def names_generator() -> Generator:
    """Generator factory: one ``<entity_snake>_names.py`` per object with a
    declared/inherited primary source. Returns a :class:`NamesGenerator`."""
    return NamesGenerator()
