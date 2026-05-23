"""Deferred super/extends resolution over the merged tree (2nd pass, pre-freeze)."""
from __future__ import annotations

from .errors import ErrorCode, MetaError
from .meta.meta_data import MetaData
from .shared.separators import PACKAGE_SEP


def resolve_supers(root: MetaData, errors: list[MetaError]) -> None:
    """Walk every node in the merged tree; for each unresolved super_ref, resolve it.

    Resolved → sets node.super_data.
    Unresolved → appends ERR_UNRESOLVED_SUPER to errors.
    Already-resolved nodes (super_data is not None) are skipped (idempotent).
    """
    index = _build_index(root)
    for node in _walk(root):
        if node.super_ref and node.super_data is None:
            target = _resolve(node.super_ref, node.effective_package(), index)
            if target is None:
                errors.append(MetaError(
                    f"the SuperClass '{node.super_ref}' does not exist "
                    f"(referenced by {node.effective_fqn()})",
                    ErrorCode.ERR_UNRESOLVED_SUPER,
                    path=node.effective_fqn(),
                ))
            else:
                node.super_data = target


def _walk(node: MetaData) -> list[MetaData]:
    """Return node + all descendants in pre-order."""
    out = [node]
    for c in node.children():
        out.extend(_walk(c))
    return out


def _build_index(root: MetaData) -> dict[str, MetaData]:
    """Build an effective_fqn → node index over the whole merged tree."""
    idx: dict[str, MetaData] = {}
    for node in _walk(root):
        if node.name:
            idx.setdefault(node.effective_fqn(), node)
    return idx


def _resolve(
    ref: str, context_pkg: str | None, index: dict[str, MetaData]
) -> MetaData | None:
    """Resolve a super_ref string against the FQN index.

    Resolution forms:
    - absolute ``::pkg::Name``  → strip leading ``::``, look up ``pkg::Name``.
    - relative ``..::rest``     → drop one trailing package segment per leading
                                  ``..::`` from context, then try
                                  ``reducedCtx::rest`` then bare ``rest``.
    - bare/qualified ``Name``   → try ``context::ref`` first, then bare ``ref``.
    """
    abs_prefix = PACKAGE_SEP  # "::"
    rel_prefix = ".." + PACKAGE_SEP  # "..::

    if ref.startswith(abs_prefix):                          # absolute ::pkg::Name
        return index.get(ref[len(abs_prefix):])

    if ref.startswith(rel_prefix):                          # relative ..::rest
        segs = (context_pkg or "").split(PACKAGE_SEP) if context_pkg else []
        rest = ref
        while rest.startswith(rel_prefix):
            rest = rest[len(rel_prefix):]
            segs = segs[:-1]
        reduced = PACKAGE_SEP.join(segs)
        qualified = f"{reduced}{PACKAGE_SEP}{rest}" if reduced else rest
        return index.get(qualified) or index.get(rest)

    # bare or pkg-qualified (no leading :: / ..)
    if context_pkg:
        hit = index.get(f"{context_pkg}{PACKAGE_SEP}{ref}")
        if hit is not None:
            return hit
    return index.get(ref)
