"""THE resolver for "which ``source.rdb`` is this object's primary" (§A3).

Before this module existed, the question was answered four times with two
different predicates. The runtime (``ObjectManager._table_name``) filtered
``source.rdb`` children on ``@role: primary``. The three codegen copies — the
router generator, the filter-allowlist generator, and the M:N descriptor
resolver — each hand-rolled their own ``_primary_source_rdb`` that took the
**first** ``source.*`` child, with no role filter at all. On any object
declaring a ``@role: replica`` source, the two predicates disagreed about
which table the object physically lives in — and the runtime is the one that
reads the rows back, so the codegen copies were the ones that were wrong.

One definition, so a names generator (or anything else that needs a physical
table name) has exactly one resolver to call — a fifth hand-rolled copy is
precisely what this module exists to forbid.

It lives at the package root, not under ``codegen/``, because the runtime and
the api-docs builder call it too. Under ``codegen/`` the runtime would have to
either invert its layering to reach it or keep its own copy — and keeping its
own copy is how the runtime came to be the one caller that fabricated a table
name for an object declaring no source at all.

**Cross-port divergence guard.** The C# (``CSharpNaming.ResolveObjectNames``)
and TypeScript (``resolveObjectNames`` in ``codegen-ts/src/names.ts``) resolvers
— and Kotlin's, by inheriting the JVM loader's validation — refuse an object
whose primary source and primary WRITABLE source resolve to two different
physical names. :func:`primary_rdb_source`'s own predicate is the LOOSE one (any
role=primary source, readable or not); a stricter role=primary+writable source
can survive alongside it when an abstract parent's own read-only primary source
and a child's own, differently-named, writable primary source both land on the
child's *effective* ``children()`` at once (own-only validation never sees the
combination — see :func:`find_primary_writable_source`). That shape loads with
zero errors, so this module — not a downstream consumer — is where it is
caught, once, for every caller of :func:`primary_rdb_source`.
"""
from __future__ import annotations

from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import SOURCE_ROLE_PRIMARY


def find_primary_writable_source(entity: MetaObject) -> MetaSource | None:
    """The primary WRITABLE ``source.rdb`` for *entity*, or ``None``.

    Mirrors C#'s ``MetaObject.FindPrimaryWritableSource`` / TS's ``obj.dbTable``
    predicate: ``@role: primary`` AND :meth:`MetaSource.is_writable`. Used ONLY
    by :func:`primary_rdb_source`'s divergence guard below — callers wanting
    "the" primary source (writable or not) call :func:`primary_rdb_source`
    itself, never this.

    ADR-0039 — ``children()`` RESOLVES, matching the loose predicate this is
    compared against (an inherited writable source must be seen too).
    """
    for c in entity.children():
        if (
            isinstance(c, MetaSource)
            and c.role() == SOURCE_ROLE_PRIMARY
            and c.is_writable()
        ):
            return c
    return None


def primary_rdb_source(entity: MetaObject) -> MetaSource | None:
    """THE primary ``source.rdb`` for *entity*, or ``None``.

    Filters on ``@role: primary`` (defaulting to ``"primary"`` when a source
    declares no ``@role`` at all — see :meth:`MetaSource.role`), mirroring
    ``object_manager.py``'s ``_table_name``. ``None`` when *entity* declares no
    primary source — #248: participation in persistence derives from a
    declared source, never from the object subtype, so an ``object.value`` (no
    source, ever) and a sourceless ``object.projection`` both resolve to
    ``None`` here rather than being special-cased by subtype.

    ADR-0039 — ``children()`` RESOLVES: a source inherited via ``extends``
    (the ``BaseEntity`` pattern) is seen; ``own_children()`` would miss it.

    Raises :class:`ValueError` — mirroring the C#/TS ports' wording exactly —
    when a primary WRITABLE source also exists (see
    :func:`find_primary_writable_source`) and resolves to a DIFFERENT physical
    name than the one returned here. No downstream consumer re-checks this;
    the refusal lives here, once, so every caller inherits it for free.
    """
    src: MetaSource | None = None
    for c in entity.children():
        if isinstance(c, MetaSource) and c.role() == SOURCE_ROLE_PRIMARY:
            src = c
            break
    if src is None:
        return None

    writable = find_primary_writable_source(entity)
    if writable is not None:
        name = src.physical_name()
        writable_name = writable.physical_name()
        if writable_name != name:
            raise ValueError(
                f'{entity.name}: the primary source resolves to physical name "{name}" '
                f"but the primary WRITABLE source resolves to "
                f'"{writable_name}" — two role=primary sources disagree on the '
                f"object's physical name. Give the read-only and writable sources "
                f"matching physical names, or drop the extra role=primary declaration."
            )
    return src


def resolve_table_name(entity: MetaObject) -> str | None:
    """The physical SQL table/view name of *entity*'s primary source, or
    ``None`` when it has none.

    Delegates to :meth:`MetaSource.physical_name` (FR-016 / ADR-0018's
    four-step rule), which resolves to a non-empty name whenever a source
    exists — so the ``None`` case here means exactly what
    :func:`primary_rdb_source` returning ``None`` means: no declared primary
    source, i.e. this object does not physically participate in persistence.
    """
    src = primary_rdb_source(entity)
    if src is None:
        return None
    return src.physical_name()


__all__ = ["primary_rdb_source", "resolve_table_name"]
