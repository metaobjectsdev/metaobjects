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
        target = _resolve(node.super_ref, effective_pkg, index, referrer_type=node.type)
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
        elif _is_child_targeting_ref(node.super_ref) and (
            target.type != node.type or target.sub_type != node.sub_type
        ):
            # FR-024 (ADR-0029): a dotted extends target must match the referrer's
            # type AND subtype (dotted-only check — top-level extends unchanged).
            # Mirrors TS resolveDeferredSupers' target-mismatch kind.
            errors.append(MetaError(
                f"the dotted extends target '{node.super_ref}' is "
                f"[{target.type}.{target.sub_type}] but the extending node is "
                f"[{node.type}.{node.sub_type}] — a dotted extends must target a "
                f"node of the same type and subtype (referenced by {node.fqn()})",
                ErrorCode.ERR_EXTENDS_TARGET_MISMATCH,
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


def _is_child_targeting_ref(ref: str) -> bool:
    """FR-024 (ADR-0029): True when the ref's final ``::``-segment contains a
    ``.`` — i.e. it targets a child nested inside an object (``Customer.id``,
    ``acme::sales::Customer.id``). Names cannot contain ``.``, so the form is
    unambiguous."""
    last_sep = ref.rfind(PACKAGE_SEP)
    last_segment = ref if last_sep < 0 else ref[last_sep + len(PACKAGE_SEP):]
    return "." in last_segment


def _resolve(
    ref: str,
    context_pkg: str | None,
    index: dict[str, MetaData],
    referrer_type: str | None = None,
) -> MetaData | None:
    """Resolve a super_ref string against the FQN index.

    Resolution forms:
    - absolute ``::pkg::Name``  → strip leading ``::``, look up ``pkg::Name``.
    - relative ``..::rest``     → count leading ``..::`` levels; if levels exceed
                                  context depth or remainder is empty → ``None``
                                  (→ ERR_UNRESOLVED_SUPER); else look up
                                  ``reducedCtx::rest`` (mirrors TS exactly).
    - bare/qualified ``Name``   → try ``context::ref`` first, then bare ``ref``.
    - dotted ``Owner.child``    → FR-024 (ADR-0029): resolve the OWNER with the
                                  strategies above, then select the child among
                                  the owner's EFFECTIVE children (``children()``,
                                  so inherited children resolve) by name + the
                                  REFERRER's type (type-scoped: a field ref
                                  resolves fields, an identity ref identities).
                                  Dotted refs never fall through to the bare
                                  lookup; multi-dot (``X.y.z``) TRAVERSES child
                                  names to any depth (intermediate segments by
                                  unique name); only degenerate empty segments →
                                  ``None``; no ``referrer_type`` → ``None``.
                                  Mirrors TS super-resolve.ts.
    """
    abs_prefix = PACKAGE_SEP  # "::"
    rel_prefix = ".." + PACKAGE_SEP  # "..::

    if _is_child_targeting_ref(ref):
        # Addressing model (ADR-0029): the package qualifies the ROOT-level node
        # only; each subsequent segment traverses CHILD NAMES to any depth
        # (object → field → view: ``Customer.priceCents.display``). INTERMEDIATE
        # segments select by UNIQUE name among the current node's effective
        # children (a cross-type name collision is ambiguous → unresolved); the
        # FINAL segment is type-scoped to the referrer. Mirrors the TS reference.
        if referrer_type is None:
            return None
        last_sep = ref.rfind(PACKAGE_SEP)
        seg_start = 0 if last_sep < 0 else last_sep + len(PACKAGE_SEP)
        parts = ref[seg_start:].split(".")
        if len(parts) < 2 or any(not p for p in parts):
            return None  # degenerate (empty segment)
        current = _resolve(ref[:seg_start] + parts[0], context_pkg, index)
        if current is None:
            return None
        for seg in parts[1:-1]:
            matches = [c for c in current.children() if c.name == seg]
            if len(matches) != 1:
                return None  # missing or ambiguous intermediate
            current = matches[0]
        last = parts[-1]
        for child in current.children():
            if child.name == last and child.type == referrer_type:
                return child
        return None

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
