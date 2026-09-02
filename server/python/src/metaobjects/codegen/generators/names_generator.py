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
consumer of :mod:`metaobjects.codegen.source_resolution` — THE resolver for
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
from metaobjects.codegen.source_resolution import primary_rdb_source
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


def render_names(entity: MetaObject, strategy: str) -> str | None:
    """Render the names module for ``entity``, or ``None`` when it declares (and
    inherits) no primary ``source.rdb`` at all (#248).

    ``strategy`` is ``GenConfig``'s column-naming-strategy field — the same value
    :func:`metaobjects.naming.resolve_column_name` applies to any field with no
    explicit ``@column``.
    """
    src = primary_rdb_source(entity)
    if src is None:
        return None

    upper = entity.name.upper()

    # ADR-0039: fields() RESOLVES — an inherited field and an inherited @column
    # both must appear here, or the constant disagrees with what the runtime
    # actually binds. Sorted by field name so output depends on the model, not
    # on child declaration order.
    rows = sorted(
        ((f.name, resolve_column_name(f, strategy)) for f in entity.fields()),
        key=lambda row: row[0],
    )

    # Two fields whose constant-member forms collide would silently lose one
    # constant to the other (the later assignment wins) rather than fail loud.
    # Mirrors the C#/Kotlin ports' guard — fail here, naming the model, rather
    # than emitting a module with a lost constant.
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
        f'{upper}_KIND: Final[str] = "{src.effective_kind()}"',
        f'{upper}_NAME: Final[str] = "{src.physical_name()}"',
    ]
    # Omitted entirely when undeclared — never emitted as `None` / a literal
    # empty string, which would read as "declared blank" rather than
    # "undeclared".
    schema = src.schema()
    if schema:
        lines.append(f'{upper}_SCHEMA: Final[str] = "{schema}"')
    lines.append(f"{upper}_READ_ONLY: Final[bool] = {src.is_read_only()}")
    lines.append("")
    for name, column in rows:
        member = _member(name)
        lines.append(f'{upper}_{member}_FIELD: Final[str] = "{name}"')
        lines.append(f'{upper}_{member}_COLUMN: Final[str] = "{column}"')
    lines.append("")
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
        def emit(entity: MetaObject, c: GenContext) -> list[EmittedFile]:
            source = render_names(entity, c.config.column_naming)
            if source is None:
                return []
            snake = _snake_case(entity.name)
            return [
                EmittedFile(
                    path=f"{snake}_names.py",
                    content=ruff_format(source),
                )
            ]

        return per_entity(emit)(ctx)


def names_generator() -> Generator:
    """Generator factory: one ``<entity_snake>_names.py`` per object with a
    declared/inherited primary source. Returns a :class:`NamesGenerator`."""
    return NamesGenerator()
