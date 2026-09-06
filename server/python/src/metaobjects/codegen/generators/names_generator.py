"""Per-object physical database name constants — one ``<entity_snake>_names.py``
per object with a declared (or inherited) primary ``source.rdb`` (#248).

The module MIRRORS THE METADATA TREE. Every node it describes — the object itself,
each ``source.rdb`` child, each ``identity.*`` and ``index.*`` child — carries its
own ``type``, ``sub_type`` and ``name``, and a source's physical name sits under the
member named for its ``@kind``. One member called ``<ENTITY>_NAME`` used to hold a
table, a view and a stored procedure in the same run, told apart only by a sibling
``<ENTITY>_KIND``, and in none of the three did it hold the object's own name::

    LEDGER_NAME          = "TBL_LDG_ENTRY"    KIND: "table"
    CUSTOMERSUMMARY_NAME = "V_CUST_ROLLUP"    KIND: "view"
    PROCOUT_NAME         = "SP_CUST_ROLLUP"   KIND: "storedProc"

``<ENTITY>_NAME`` is now the OBJECT's metamodel name, and the physical name is
``<ENTITY>_SOURCE_<ROLE>_TABLE`` / ``_VIEW`` / ``_PROC`` — the member says what the
thing IS, so a reader does not have to consult a second constant to find out.

Mirrors the shipped TypeScript ``ObjectNames``/``SourceNames``/``KeyNames`` shape
(``codegen-ts/src/names.ts``) member for member, in Python's idiom: module-level
``Final`` SCALARS rather than a dict of dicts — mypy narrows a ``Final[str]`` to a
literal type, while a dict lookup is merely ``str`` — plus the
``<ENTITY>_COLUMNS_BY_FIELD`` map whose values REFERENCE those constants rather
than repeating the literals.

Three rules the shape carries, each of which has a reason and none of which is a
Python-local invention:

* **The type prefix is load-bearing, and fields are the ONE exception.** A source
  is ``<ENTITY>_SOURCE_<ROLE>_*``, an identity ``<ENTITY>_IDENTITY_<NAME>_*``, an
  index ``<ENTITY>_INDEX_<NAME>_*``; a field stays ``<ENTITY>_<FIELD>_FIELD`` /
  ``_COLUMN``. A field's sub_type does not change what ``COLUMN`` denotes, while an
  object's decides table-vs-view and an identity's decides unique-vs-not (ADR-0040
  put uniqueness in the TYPE rather than in an attribute). The prefix is also what
  keeps the members apart at all: ``identity.primary`` carries ``defaultName:
  "primary"``, so an unnamed primary key and a ``@role: primary`` source both want
  ``<ENTITY>_PRIMARY_*`` — one silently overwriting the other, the later assignment
  winning.

* **Sources are keyed by effective ``@role``**, and the physical name sits under the
  alias for the source's ``@kind``, taken from ``PHYSICAL_NAME_ATTR_BY_KIND`` — the
  metamodel's own FR-016/ADR-0018 map, never a local dict, so a sixth ``@kind`` does
  not need an edit here to be spelled correctly. Keying by role is what finally gives
  a WRITE-THROUGH entity's replica view a slot: it declares two physical names and
  the artifact carried one.

* **``READ_ONLY`` is removed rather than relocated.** It is not metadata — it is a
  derivation over ``@kind`` (:meth:`MetaSource.is_read_only`) — and a sweep of all
  five ports found zero consumers, generated or hand-written. A module that mirrors
  the tree carries what was declared; a reader who wants read-only-ness asks
  ``<ENTITY>_SOURCE_<ROLE>_KIND``, which is the thing the author actually wrote.

An ``<ENTITY>_..._INDEX`` member — the database index name — exists only where a
shared resolver produces it: ``identity.secondary`` and ``index.lookup``, via
:func:`metaobjects.naming.resolve_index_name`. Deliberately ABSENT on
``identity.primary``, because no such name exists to carry (migrate hardcodes
``<table>_pkey`` on Postgres, emits an unnamed PK on SQLite, and no port's codegen
names a primary key at all), and absent on ``identity.reference`` unless a
constraint name is explicitly declared. Carrying one would restate a migrate-only,
dialect-conditional formula in an artifact whose whole promise is that a name is
spelled once.

Participation derives from a declared/inherited primary source, never from the
object subtype (#248): an ``object.value`` (no source, ever) and a sourceless
``object.projection`` both resolve to no artifact here, the same as any other
consumer of :mod:`metaobjects.source_resolution` — THE resolver for "which
``source.rdb`` is this object's primary", so this generator does not hand-roll a
sixth copy of that predicate.

The Python surface this artifact backs is a bare Pydantic class with no ORM
binding, so before this generator existed there was no route at all from a model to
the column a row actually lands in — the one place that answer lives was
:func:`metaobjects.naming.resolve_column_name`, called directly. This is that same
resolver's answer, materialized as importable constants.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator, per_entity
from metaobjects.meta.core.identity.identity_constants import IDENTITY_SUBTYPE_SECONDARY
from metaobjects.meta.core.index.index_constants import INDEX_SUBTYPE_LOOKUP
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import (
    PHYSICAL_NAME_ATTR_BY_KIND,
)
from metaobjects.naming import (
    resolve_column_name,
    resolve_index_name,
    strip_package,
    to_snake_case,
)
from metaobjects.shared.base_types import TYPE_IDENTITY, TYPE_INDEX
from metaobjects.source_resolution import primary_rdb_source

#: The nodes whose DATABASE index name this module carries.
#:
#: A closed set rather than "anything with a name", because the rule is narrow and
#: worth stating: the artifact carries a physical name only where ONE resolver,
#: shared across the toolchain, produces it. ``identity.primary`` and
#: ``identity.reference`` have names that are addressing handles, not database names.
INDEX_NAMED_SUBTYPES: frozenset[str] = frozenset({
    f"{TYPE_IDENTITY}.{IDENTITY_SUBTYPE_SECONDARY}",
    f"{TYPE_INDEX}.{INDEX_SUBTYPE_LOOKUP}",
})

#: Anything a Python identifier may not contain. An ``index.lookup`` name is
#: author-chosen and need not be an identifier (``uq_cust_email`` is, ``2fa-idx`` is
#: not); a dict key can be quoted, a module-level constant cannot, so the character
#: is folded to ``_``. Two names that fold together are caught by the collision guard
#: below, which names both nodes — the same answer a quoted key would have avoided
#: needing, reached honestly instead of by silently keeping one.
_NON_MEMBER_CHAR = re.compile(r"[^0-9A-Za-z_]")


def _effective_fqn(entity: MetaObject) -> str:
    """``package::name`` via the canonical :meth:`MetaData.resolution_key`.
    Mirror of the filter-allowlist / router generators' helper of the same
    name."""
    return entity.resolution_key()


def _member(name: str) -> str:
    """The SCREAMING_SNAKE member-name segment for a metadata name — the same
    camelCase-to-snake_case algorithm :func:`metaobjects.naming.to_snake_case`
    already applies for the ``snake_case`` column-naming strategy, upper-cased.
    ``createdAt`` -> ``CREATED_AT``.

    Package-stripped and identifier-folded, because this is applied to author-chosen
    index names as well as to field names.
    """
    return _NON_MEMBER_CHAR.sub("_", to_snake_case(strip_package(name))).upper()


@dataclass(frozen=True)
class _Const:
    """One emitted constant, before it is decided whether it is a literal or a
    reference to the super module's own.

    ``member`` is the name WITHOUT the ``<ENTITY>_`` prefix, which is what makes the
    inherited form fall out for free: a node's member segment is identical in every
    module along the ``extends`` chain, so an inherited constant's value is exactly
    ``<SUPER>_<member>``.
    """

    member: str
    #: The Python source for the value when this module declares the node itself.
    literal: str
    #: The node this constant describes, for a collision diagnostic that can be acted on.
    path: str


def _q(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _object_consts(entity: MetaObject) -> list[_Const]:
    """The object's OWN identity — never inherited, even by a TPH subtype sharing its
    base's single table. A single-table hierarchy legitimately has two of these."""
    path = f"{entity.type}.{entity.sub_type} {entity.name!r}"
    return [
        _Const("TYPE", _q(entity.type), path),
        _Const("SUB_TYPE", _q(entity.sub_type), path),
        _Const("NAME", _q(entity.name), path),
    ]


def _source_consts(src: MetaSource) -> list[_Const]:
    """One ``source.rdb`` child, under the role it plays."""
    role = src.role()
    kind = src.effective_kind()
    prefix = f"{src.type.upper()}_{_member(role)}"
    path = f'{src.type}.{src.sub_type} @role "{role}"'
    out = [
        _Const(f"{prefix}_TYPE", _q(src.type), path),
        _Const(f"{prefix}_SUB_TYPE", _q(src.sub_type), path),
        _Const(f"{prefix}_KIND", _q(kind), path),
    ]
    schema = src.schema()
    # Omitted entirely when undeclared — never emitted as `None` / a blank literal,
    # which would read as "declared blank" rather than "undeclared". An absent
    # @schema means "the dialect's default", which a caller expresses by omitting
    # the qualifier, not by being handed "public".
    if schema:
        out.append(_Const(f"{prefix}_SCHEMA", _q(schema), path))
    # The metamodel's map, never a local switch: a sixth @kind must not need an edit
    # here to be spelled correctly, and a local copy is a second answer to a question
    # that already has one.
    alias = PHYSICAL_NAME_ATTR_BY_KIND.get(kind)
    if alias is not None:
        out.append(_Const(f"{prefix}_{_member(alias)}", _q(src.physical_name()), path))
    return out


def _key_consts(node: MetaData) -> list[_Const]:
    """One ``identity.*`` or ``index.*`` child.

    ``SUB_TYPE`` is load-bearing rather than decorative: it is the ONLY thing
    distinguishing a unique alternate key from a non-unique lookup index, which is
    the whole reason ADR-0040 put uniqueness in the type rather than in an attribute.
    """
    prefix = f"{node.type.upper()}_{_member(node.name)}"
    path = f"{node.type}.{node.sub_type} {node.name!r}"
    out = [
        _Const(f"{prefix}_TYPE", _q(node.type), path),
        _Const(f"{prefix}_SUB_TYPE", _q(node.sub_type), path),
        _Const(f"{prefix}_NAME", _q(strip_package(node.name)), path),
    ]
    if f"{node.type}.{node.sub_type}" in INDEX_NAMED_SUBTYPES:
        # resolve_index_name owns BOTH the package strip and the empty-name refusal,
        # so this module and any DDL cannot disagree about what an index is called —
        # and an `index.lookup` with an empty name (which the loader accepts, unlike
        # an identity) fails here instead of reaching an emitter.
        out.append(_Const(f"{prefix}_INDEX", _q(resolve_index_name(node)), path))
    return out


def _field_consts(field: MetaData, column: str) -> list[_Const]:
    """One field. The ONE node kind with no type prefix: a field's sub_type does not
    change what ``COLUMN`` denotes.

    Both names, always. They are two different names for one field, they differ the
    moment a case boundary or a ``@column`` appears, and a consumer holding one cannot
    recover the other — ``@column`` is free-form, so ``callPurpose`` may map to
    ``purpose_code``, which is neither the logical name nor any transformation of it.
    """
    member = _member(field.name)
    path = f"field {field.name!r}"
    return [
        _Const(f"{member}_FIELD", _q(field.name), path),
        _Const(f"{member}_COLUMN", _q(column), path),
    ]


def declares_names_content(entity: MetaObject) -> bool:
    """Whether ``entity`` DECLARES anything a names module carries.

    One predicate, because the module has four collections and the two places that ask
    this question must agree about all four. They used to ask about fields alone, and
    the cost was precise: an intermediate abstract declaring only an
    ``identity.secondary`` — a key hoisted onto a chain, which is the whole reason such
    a node exists — answered "no". :func:`names_artifact_super_of` then walked past it
    and no module was rendered for it, so the child re-stated the key's literal instead
    of referencing it. No import broke, which is why nothing caught it; the guarantee
    did — the physical name is supposed to be spelled ONCE.

    ADR-0039: the own-only accessors are correct HERE — the question is what this node
    declares, not what it can see. An inherited key belongs to the ancestor that
    declared it and is reached through that ancestor's module.
    """
    return bool(
        entity.own_fields()
        or [c for c in entity.own_children() if c.type in (TYPE_IDENTITY, TYPE_INDEX)]
    )


def names_artifact_super_of(entity: MetaObject) -> MetaObject | None:
    """The nearest ancestor of ``entity`` carrying a names module of its own, or None.

    Walks PAST an ancestor with nothing to contribute — an abstract marker with no
    fields, no keys and no source emits no module, so there is nothing to import and the
    search continues upward rather than stopping at a name that does not exist.
    """
    cur = entity.super_data
    while cur is not None:
        if isinstance(cur, MetaObject) and (
            declares_names_content(cur) or primary_rdb_source(cur) is not None
        ):
            return cur
        cur = cur.super_data
    return None


def _sources_by_role(entity: MetaObject) -> dict[str, MetaSource]:
    """Every ``source.rdb`` child of *entity*, keyed by effective ``@role``.

    ADR-0039: ``children()`` RESOLVES — a source inherited via ``extends`` (the TPH
    pattern) is seen; ``own_children()`` would miss it.

    The refusal is about DISAGREEMENT, not about the count — deliberately the SAME
    rule :func:`primary_rdb_source` already enforces for the physical name, rather
    than a stricter one invented here. An abstract base and the child that extends it
    may each declare a ``@role: primary`` source naming the same relation; that is
    legal today, and refusing it would make this module stricter than the invariant
    it exists to serve.

    Two sources in one role that resolve DIFFERENTLY is the real problem, and silently
    keeping one is the failure mode this artifact makes impossible: the second name is
    carried nowhere, read by nobody, and the binding quietly takes the first's.

    What this sees that :func:`primary_rdb_source` cannot is the non-name half —
    ``@kind`` and ``@schema``. That function compares physical NAMES, so two primaries
    agreeing on the name and differing on which schema it lives in get past it and land
    on one role key here. (Two sources reach one role key only when both are OWN
    children or both carry an explicit structural ``name``: effective-children
    shadowing matches on ``(type, name)``, so two UNNAMED sources across an ``extends``
    boundary collapse into one before this ever runs.)
    """
    out: dict[str, MetaSource] = {}
    for child in entity.children():
        if not isinstance(child, MetaSource):
            continue
        role = child.role()
        existing = out.get(role)
        if existing is None:
            out[role] = child
            continue
        was = {c.member: c.literal for c in _source_consts(existing)}
        now = {c.member: c.literal for c in _source_consts(child)}
        if was != now:
            # Name the disagreeing MEMBERS, not just the physical names: the arm this
            # check owns is the one where the physical names AGREE and something else
            # (@kind, @schema) does not, and a message quoting only the names would
            # read as though nothing were wrong.
            differing = sorted(set(was) | set(now))
            detail = ", ".join(
                f"{m}: {was.get(m, '<absent>')} vs {now.get(m, '<absent>')}"
                for m in differing
                if was.get(m) != now.get(m)
            )
            raise ValueError(
                f'{entity.name} declares more than one source.rdb with @role: "{role}", '
                f'and they do not agree — "{existing.physical_name()}" vs '
                f'"{child.physical_name()}" ({detail}). The names module keys sources '
                f"by role, so the second has nowhere to go."
            )
    return out


def render_names(entity: MetaObject, strategy: str, *, fragment: bool = False) -> str | None:
    """Render the names module for ``entity``, or ``None`` when it declares (and
    inherits) no primary ``source.rdb`` at all (#248).

    ``strategy`` is ``GenConfig``'s column-naming-strategy field — the same value
    :func:`metaobjects.naming.resolve_column_name` applies to any field with no
    explicit ``@column``.

    ``fragment=True`` renders the FRAGMENT form: an abstract base that a sourced object
    extends, carrying the columns and keys it declares and NO source — it has no
    physical name and must never acquire one. That form is separate on purpose, and the
    separation is the #248 rule intact rather than weakened: "has a primary source"
    still decides database participation, so an ``object.value`` carrying fields renders
    nothing as it always has. A fragment is rendered only for an object REACHED from a
    participant by walking ``extends`` upward — the only context in which its fields are
    columns at all.
    """
    src = primary_rdb_source(entity)
    if fragment:
        if not declares_names_content(entity):
            # An abstract marker has nothing to import; an empty module would put a name
            # in the package that says nothing. "Nothing" is the same question
            # `names_artifact_super_of` asks, so the walk and the render cannot disagree
            # about which ancestors exist.
            return None
    elif src is None:
        return None

    upper = entity.name.upper()

    # Python has no static inheritance to lean on, so a module with a super re-exports
    # the inherited constants BY REFERENCE rather than restating their literals — one
    # spelling of each physical name, which is the whole guarantee. (C# and Java use
    # real class inheritance; the emitted shape differs per language, the guarantee
    # does not.)
    super_obj = names_artifact_super_of(entity)
    super_upper = None if super_obj is None else super_obj.name.upper()
    # Membership by NODE IDENTITY in the super's own resolving set, not "absent from
    # own_children()". Those differ exactly where it matters: a node declared by an
    # ancestor that `names_artifact_super_of` SKIPPED (no fields and no source, so no
    # module) is inherited but is NOT in the super module — referencing it would emit
    # an import of a name that does not exist. Identity also gets shadowing right for
    # free: a child re-declaring a field returns its OWN node from `children()`.
    super_nodes: set[int] = set() if super_obj is None else {id(c) for c in super_obj.children()}

    def carried_by_super(node: MetaData) -> bool:
        return super_upper is not None and id(node) in super_nodes

    # (section, consts, inherited) in emission order: object identity, sources,
    # fields, identities, indexes. Each collection is sorted by its own key so the
    # output depends on the model, not on child declaration order.
    groups: list[tuple[str, list[_Const], bool]] = [("object", _object_consts(entity), False)]

    if not fragment:
        # A fragment declares no source and must never acquire one. An object that
        # INHERITS its source (a TPH subtype sharing its base's single table) takes
        # its constants from the base module by reference rather than restating them.
        by_role = _sources_by_role(entity)
        for role in sorted(by_role):
            source = by_role[role]
            groups.append(("sources", _source_consts(source), carried_by_super(source)))

    # ADR-0039: fields() RESOLVES — an inherited field and an inherited @column both
    # must appear here, or the constant disagrees with what the runtime actually binds.
    columns: list[tuple[str, str]] = []
    for field in sorted(entity.fields(), key=lambda f: f.name):
        column = resolve_column_name(field, strategy)
        columns.append((field.name, column))
        groups.append(("fields", _field_consts(field, column), carried_by_super(field)))

    for type_name in (TYPE_IDENTITY, TYPE_INDEX):
        keys = sorted(
            (c for c in entity.children() if c.type == type_name),
            key=lambda c: c.name,
        )
        for node in keys:
            groups.append((type_name, _key_consts(node), carried_by_super(node)))

    # Two nodes whose constant members collide would silently lose one constant to the
    # other (the later assignment wins) rather than fail loud.
    #
    # Checked over the WHOLE emitted member set — every collection, inherited entries
    # included — never per collection and never own-only. Once a child stopped restating
    # its inherited constants, an own-only check could no longer see a collision that
    # spans the `extends` boundary, and here BOTH constants land in the SAME module (the
    # child re-exports the inherited one under its own name), so the later assignment
    # would silently win. Across collections it is what makes the type prefix provable
    # rather than merely intended.
    seen: dict[str, str] = {}
    for _section, consts, _inherited in groups:
        for const in consts:
            name = f"{upper}_{const.member}"
            first = seen.get(const.member)
            if first is not None and first != const.path:
                raise ValueError(
                    f"{entity.name}: {first} and {const.path} both yield the constant "
                    f"{name}. Rename one, or give it an explicit @column."
                )
            seen[const.member] = const.path

    lines: list[str] = [
        generated_header(entity.name, _effective_fqn(entity)).rstrip() + "\n"
        + f'"""GENERATED — per-object physical database names for '
        f'{entity.name} (#248)."""\n',
        "from __future__ import annotations",
        "",
        "from typing import Final",
        "",
    ]

    body: list[str] = []
    # EVERY name this module references must be imported. Collected from the emitted
    # lines themselves rather than reconstructed alongside them: an inherited member
    # referenced but not imported is a NameError at IMPORT time, and a hand-assembled
    # list is how the source-level constants came to be left out of one.
    imports: set[str] = set()
    section = ""
    for group_section, consts, inherited in groups:
        if section and group_section != section:
            body.append("")
        section = group_section
        for const in consts:
            name = f"{upper}_{const.member}"
            if inherited:
                assert super_upper is not None  # carried_by_super implies a super module
                referenced = f"{super_upper}_{const.member}"
                imports.add(referenced)
                body.append(f"{name}: Final[str] = {referenced}")
            else:
                body.append(f"{name}: Final[str] = {const.literal}")
    body.append("")

    if imports:
        assert super_obj is not None  # an import can only name the super module
        lines.append(
            f"from .{_snake_case(super_obj.name)}_names import (\n"
            + "".join(f"    {m},\n" for m in sorted(imports))
            + ")"
        )
        lines.append("")
    lines.extend(body)

    # Stays COMPLETE — every field, inherited included — because it is the lookup
    # surface, and a miss on an inherited field is exactly the fallback-to-literal this
    # artifact removes. It repeats no LITERAL: an inherited entry's value is this
    # module's re-exported reference to the base's own constant. Always emitted, even
    # when empty, so a consumer can read it unconditionally.
    lines.append(f"{upper}_COLUMNS_BY_FIELD: Final[dict[str, str]] = {{")
    for name, _column in columns:
        lines.append(f'    "{name}": {upper}_{_member(name)}_COLUMN,')
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
                # "Fragment" means "declares no source", so it is DERIVED rather than
                # asserted. Hardcoding True was right for the shape this pass was written
                # for -- an abstract base with columns and no table -- and wrong for the one
                # it also reaches: a scoped run (`--entities <Subtype>`) walks up to a TPH
                # BASE, which owns the shared table. Rendered as a fragment it emitted no
                # SOURCE_* constants at all, while the subtype's module still referenced
                # them by name -- an ImportError on a module the tool had just written.
                files += one(sup, fragment=primary_rdb_source(sup) is None)
                sup = names_artifact_super_of(sup)
        return files


def names_generator() -> Generator:
    """Generator factory: one ``<entity_snake>_names.py`` per object with a
    declared/inherited primary source. Returns a :class:`NamesGenerator`."""
    return NamesGenerator()
