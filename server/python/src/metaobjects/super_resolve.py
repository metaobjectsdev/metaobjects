"""Deferred super/extends resolution over the merged tree (2nd pass, pre-freeze).

Mirrors TS ``resolveDeferredSupers`` in super-resolve.ts:
- Walk the tree over own_children(), tracking an inherited context package.
- Build the FQN index keyed by node.fqn() (own).
- For each node with an unresolved super_ref, resolve using
  ``effective_pkg = node.package or inherited_context_pkg``.
"""
from __future__ import annotations

from .errors import ErrorCode, MetaError
from .meta.meta_data import MetaData
from .shared.separators import PACKAGE_SEP
from .source import resolved_source


def resolve_supers(root: MetaData, errors: list[MetaError]) -> None:
    """Walk every node in the merged tree; for each unresolved super_ref, resolve it.

    Resolved → sets node.super_data.
    Unresolved → appends ERR_UNRESOLVED_SUPER to errors.
    Already-resolved nodes (super_data is not None) are skipped (idempotent).
    """
    index = _build_index(root)
    _walk(root, "", index, errors)


def _walk(
    node: MetaData,
    ctx_pkg: str,
    index: dict[str, MetaData],
    errors: list[MetaError],
) -> None:
    """Visit *node* then recurse over own_children(), carrying an inherited context package."""
    if node.super_ref and node.super_data is None:
        # Referrer context package: own ``package`` if declared, else the
        # file-default package captured at parse time, else the inherited
        # walk context. Using file_default_package (not just the threaded
        # ctx_pkg) is what lets a bare / same-package / cross-package
        # ``extends`` resolve over the MERGED tree, where object nodes carry
        # no own package and the parent chain no longer reaches the per-file
        # root. Mirrors TS ``resolveDeferredSupers``
        # (``node.package ?? node.fileDefaultPackage``).
        effective_pkg = node.package or node.file_default_package or ctx_pkg or None
        target = _resolve(node.super_ref, effective_pkg, index)
        if target is None:
            # FR5d / ADR-0009: emit a ResolvedSource envelope carrying the
            # referrer's files / json_path plus the referrer FQN + unresolved
            # target. Mirrors TS resolveDeferredSupers in meta-data-loader.ts.
            errors.append(MetaError(
                f"the SuperClass '{node.super_ref}' does not exist "
                f"(referenced by {node.fqn()})",
                ErrorCode.ERR_UNRESOLVED_SUPER,
                path=node.fqn(),
                envelope=resolved_source(node.source, node.fqn(), node.super_ref),
            ))
        else:
            node.super_data = target

    # The context package for children is this node's own package, if set, else inherit.
    next_ctx = node.package or ctx_pkg
    for child in node.own_children():
        _walk(child, next_ctx, index, errors)


def _build_index(root: MetaData) -> dict[str, MetaData]:
    """Build a lookup index over the whole merged tree (own_children walk).

    Each named node is registered under its own ``fqn()`` AND — when it has no
    own ``package`` but a file-default package was captured at parse time —
    under the package-folded key ``<file_default_package>::<name>``. The second
    key is what makes a cross-package fully-qualified ``extends`` resolve over
    the merged tree (object ``fqn()`` stays bare because the parser does not
    fold the file-default package onto the object's own package). Mirrors the
    TS ``findInTree`` matcher (own ``fqn()`` OR ``resolutionKey()``).
    """
    idx: dict[str, MetaData] = {}
    _index_walk(root, idx)
    return idx


def _index_walk(node: MetaData, idx: dict[str, MetaData]) -> None:
    if node.name:
        idx.setdefault(node.fqn(), node)
        if not node.package and node.file_default_package:
            folded = f"{node.file_default_package}{PACKAGE_SEP}{node.name}"
            idx.setdefault(folded, node)
    for child in node.own_children():
        _index_walk(child, idx)


def _resolve(
    ref: str, context_pkg: str | None, index: dict[str, MetaData]
) -> MetaData | None:
    """Resolve a super_ref string against the FQN index.

    Resolution forms:
    - absolute ``::pkg::Name``  → strip leading ``::``, look up ``pkg::Name``.
    - relative ``..::rest``     → count leading ``..::`` levels; if levels exceed
                                  context depth or remainder is empty → ``None``
                                  (→ ERR_UNRESOLVED_SUPER); else look up
                                  ``reducedCtx::rest`` (mirrors TS exactly).
    - bare/qualified ``Name``   → try ``context::ref`` first, then bare ``ref``.
    """
    abs_prefix = PACKAGE_SEP  # "::"
    rel_prefix = ".." + PACKAGE_SEP  # "..::

    if ref.startswith(abs_prefix):                          # absolute ::pkg::Name
        return index.get(ref[len(abs_prefix):])

    if ref.startswith(rel_prefix):                          # relative ..::rest
        parts = ref.split(PACKAGE_SEP)
        levels = 0
        while levels < len(parts) and parts[levels] == "..":
            levels += 1
        pkg_parts = context_pkg.split(PACKAGE_SEP) if context_pkg else []
        remainder = parts[levels:]
        if len(pkg_parts) < levels or len(remainder) == 0:
            return None
        all_parts = pkg_parts[: len(pkg_parts) - levels] + remainder
        return index.get(PACKAGE_SEP.join(all_parts))

    # bare or pkg-qualified (no leading :: / ..)
    if context_pkg:
        hit = index.get(f"{context_pkg}{PACKAGE_SEP}{ref}")
        if hit is not None:
            return hit
    return index.get(ref)
