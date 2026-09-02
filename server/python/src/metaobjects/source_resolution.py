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

**Cross-port divergence guard.** Every port refuses an object whose ``@role: primary``
sources resolve to more than one physical name. The shape loads with ZERO errors:
``validate_one_primary_source`` enforces "exactly one primary" over OWN children only,
and effective-children shadowing matches an own child over a super child only on a
``(type, name)`` pair — so two ``source.rdb`` nodes with DIFFERENT explicit names at two
levels of an ``extends`` chain never collide, and both land on the child's *effective*
``children()``. Downstream every consumer references one name unconditionally, so the
refusal lives here, once, for every caller of :func:`primary_rdb_source`.

The check is deliberately DIRECTION-BLIND, and that is a correction. It used to compare
"the first primary source" against "the first primary WRITABLE source", which can only
see a divergence when one of the two primaries is read-only — and since ``children()``
places INHERITED entries before own, only when the read-only one is the *inherited* one.
The mirror shape — a parent and a child each declaring their own differently-named
WRITABLE primary — was silent, and silence there is the worse outcome: the child declares
``@table`` and every generated artifact binds the parent's table instead. Both shapes load
with zero errors; both are now refused.
"""
from __future__ import annotations

from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import SOURCE_ROLE_PRIMARY


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

    Raises :class:`ValueError` — mirroring the other four ports' wording exactly —
    when the resolving children carry MORE THAN ONE ``@role: primary`` source and
    they do not agree on a physical name. Direction-blind: it compares every
    primary against every other, so it does not matter which of them is writable,
    nor which was declared first. See the module docstring for why that matters.
    No downstream consumer re-checks this; the refusal lives here, once, so every
    caller inherits it for free.
    """
    primaries = [
        c
        for c in entity.children()
        if isinstance(c, MetaSource) and c.role() == SOURCE_ROLE_PRIMARY
    ]
    if not primaries:
        return None

    names = sorted({s.physical_name() for s in primaries})
    if len(names) > 1:
        joined = ", ".join(f'"{n}"' for n in names)
        raise ValueError(
            f"{entity.name}: role=primary sources disagree on the object's physical "
            f"name — {joined}. Every consumer binds ONE name. Give them matching "
            f"physical names, or drop the extra role=primary declaration."
        )
    return primaries[0]


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
