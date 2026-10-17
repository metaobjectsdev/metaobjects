"""Deferred super/extends resolution over the merged tree (2nd pass, pre-freeze).

Mirrors TS ``resolveDeferredSupers`` in super-resolve.ts:
- Index the root's top-level nodes by exact resolution key (ADR-0059 R2).
- Collect every node carrying an unresolved super_ref; its referrer package is its
  own file's effective package.
- Resolve supers ON DEMAND with memoization + cycle detection (#188), NOT in a
  single physical-declaration-order pass — so resolution is order-independent.
"""
from __future__ import annotations

from .errors import ErrorCode, MetaError
from .meta.core.identity.identity_constants import IDENTITY_UNIQUE_KEY_SUBTYPES
from .meta.meta_data import MetaData
from .naming_refs import RefOverDropError, owner_candidate_keys
from .shared.base_types import TYPE_IDENTITY
from .shared.separators import PACKAGE_SEP
from .source import resolved_source


def extends_target_compatible(node: MetaData, target: MetaData) -> bool:
    """Whether a dotted ``extends`` target is acceptable for the extending node.

    Type must match exactly. Subtype must match too — with ONE exception, on identities
    (#310). For an identity, subtype equality was answering the wrong question: it read as
    "the same kind of thing", but ADR-0040 encodes uniqueness in the TYPE, so ``primary``
    and ``secondary`` are both UNIQUE KEYS and differ only in which one the entity
    nominated as its main handle. Borrowing a key borrows uniqueness, not that nomination
    — so a read model may key off a business key the entity models as ``identity.secondary``
    while never surfacing its surrogate ``identity.primary`` at all.

    ``identity.reference`` is excluded on both sides: a foreign key is not unique, so it
    can never back a borrowed key.
    """
    if target.type != node.type:
        return False
    if target.sub_type == node.sub_type:
        return True
    return (
        node.type == TYPE_IDENTITY
        and node.sub_type in IDENTITY_UNIQUE_KEY_SUBTYPES
        and target.sub_type in IDENTITY_UNIQUE_KEY_SUBTYPES
    )


# The one wording for ERR_EXTENDS_TARGET_MISMATCH, mirrored in the other three ports.
EXTENDS_TARGET_MISMATCH_RULE = (
    "a dotted extends must target a node of the same type and subtype — the one exception "
    "is an identity, which may extend any UNIQUE key (identity.primary or identity.secondary)"
)


def resolve_supers(root: MetaData, errors: list[MetaError]) -> None:
    """Resolve every unresolved super_ref in the merged tree, order-independently.

    Resolved → sets node.super_data.
    Unresolved → appends ERR_UNRESOLVED_SUPER to errors.
    Dotted target type/subtype mismatch → appends ERR_EXTENDS_TARGET_MISMATCH.
    Already-resolved nodes (super_data is not None) are skipped (idempotent).

    #188: super-resolution must be ORDER-INDEPENDENT. A pre-order walk resolved
    each node's super_ref in physical-declaration (= load) order, so a dotted ref
    to an INHERITED member (``extends: Owner.member`` where Owner inherits
    ``member`` via its OWN ``extends``) only succeeded when the owner's extends
    chain happened to be wired first — green under one readdir order, throwing
    ERR_UNRESOLVED_SUPER under another. Instead resolve ON DEMAND with
    memoization + cycle detection: before a dotted ref reads ``owner.children()``
    (EFFECTIVE children — inherited members appear only once the owner's OWN
    super is resolved), resolve the owner's whole chain first. The result is a
    pure function of the source SET, independent of enumeration order. Mirrors
    the TS reference (#188).
    """
    index = _build_index(root)

    # Every node carrying a super_ref, over the PHYSICAL declaration tree.
    pending: list[MetaData] = []
    _collect(root, pending)

    # Nodes already attempted this pass. On-demand resolution can reach a node
    # via the ``pending`` loop AND via owner/target recursion — ``attempted``
    # makes each node resolve (and, on failure, report) EXACTLY ONCE, restoring
    # the single-visit walk's no-duplicate-failures guarantee (a successful node
    # is deduped by ``super_data``; this also covers the FAILURE path, which
    # sets no marker). It is also the cycle guard: ``attempted`` is never
    # removed, so a genuine super cycle (A→B→A) terminates on re-entry to the
    # already-attempted node rather than recursing forever. Mirrors the TS
    # reference (#188).
    attempted: set[MetaData] = set()

    def resolve_node(node: MetaData) -> None:
        if not node.super_ref or node.super_data is not None:
            return
        if node in attempted:
            return  # already resolved-or-failed this pass — never re-report
        attempted.add(node)
        # ADR-0059 R3: the referrer package of an ``extends`` is the declaring node's
        # own file package: its ``package``, else the file-default package captured at
        # parse time ("" for a file that declares none).
        effective_pkg = node.effective_package()

        # For a dotted child-targeting ref, ``_resolve`` reads the OWNER's
        # effective ``children()`` — which only includes inherited members once
        # the owner's own extends chain is resolved. So resolve the owner node's
        # chain FIRST (memoized), regardless of load order (#188).
        if _is_child_targeting_ref(node.super_ref):
            owner_ref = _owner_ref(node.super_ref)
            if owner_ref is not None:
                owner = _try_resolve(owner_ref, effective_pkg, index)
                if owner is not None and owner != _OVER_DROP:
                    resolve_node(owner)

        # FR-024: thread the referrer's type so dotted ``Entity.child`` refs
        # resolve type-scoped (a field ref selects fields; an identity ref
        # identities).
        target = _try_resolve(node.super_ref, effective_pkg, index, referrer_type=node.type)

        if target == _OVER_DROP:
            # ADR-0059 R2 -- ``..::`` dropped more segments than the package has.
            errors.append(MetaError(
                f"the extends ref '{node.super_ref}' on {node.fqn()} climbs above the "
                f"root package \u2014 each '..::' drops one segment of the declaring package",
                ErrorCode.ERR_BAD_ATTR_VALUE,
                path=node.fqn(),
                envelope=resolved_source(node.source, node.fqn(), node.super_ref),
            ))
        elif target is None:
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
        elif _is_child_targeting_ref(node.super_ref) and not extends_target_compatible(
            node, target
        ):
            # FR-024 (ADR-0029): a dotted extends target must match the referrer's
            # type AND subtype (dotted-only check — top-level extends unchanged), with
            # the #310 identity exception. Mirrors TS resolveDeferredSupers.
            errors.append(MetaError(
                f"the dotted extends target '{node.super_ref}' is "
                f"[{target.type}.{target.sub_type}] but the extending node is "
                f"[{node.type}.{node.sub_type}] — {EXTENDS_TARGET_MISMATCH_RULE} "
                f"(referenced by {node.fqn()})",
                ErrorCode.ERR_EXTENDS_TARGET_MISMATCH,
                path=node.fqn(),
                envelope=resolved_source(node.source, node.fqn(), node.super_ref),
            ))
        else:
            node.super_data = target
            # Ensure the target's OWN chain is resolved too, so a later
            # ``children()`` read on *node* (codegen/validation) sees the full
            # multi-level inherited set (e.g. Base extends AbstractRoot).
            # Memoized — no re-work.
            resolve_node(target)

    for node in pending:
        resolve_node(node)


def _collect(node: MetaData, pending: list[MetaData]) -> None:
    """Pre-order walk over the PHYSICAL declaration tree: record every node carrying a
    super_ref."""
    if node.super_ref:
        pending.append(node)
    # ADR-0039 sanctioned own: this IS the super-resolution collection walk -- it
    # runs BEFORE extends is resolved (resolution sets super_data), so it must
    # iterate own children.
    for child in node.own_children():
        _collect(child, pending)


def _build_index(root: MetaData) -> dict[str, MetaData]:
    """The root's top-level named nodes, keyed by exact resolution key
    (``<package | file-default package>::<name>``, or the bare name for a root-level
    node). The key is captured at parse time, so a match does not depend on load order
    or on post-merge tree shape. Exact only: a bare key never matches a packaged node
    (ADR-0059 R2). First declaration wins."""
    idx: dict[str, MetaData] = {}
    # ADR-0039 sanctioned own: super-resolution reads the PHYSICAL declaration layer;
    # the root has no super, so its own children are its children.
    for c in root.own_children():
        if c.name:
            idx.setdefault(c.resolution_key(), c)
    return idx


def _is_child_targeting_ref(ref: str) -> bool:
    """FR-024 (ADR-0029): True when the ref's final ``::``-segment contains a
    ``.`` — i.e. it targets a child nested inside an object (``Customer.id``,
    ``acme::sales::Customer.id``). Names cannot contain ``.``, so the form is
    unambiguous."""
    last_sep = ref.rfind(PACKAGE_SEP)
    last_segment = ref if last_sep < 0 else ref[last_sep + len(PACKAGE_SEP):]
    return "." in last_segment


def _owner_ref(ref: str) -> str | None:
    """The OWNER portion of a dotted child-targeting ref (``Owner.child`` →
    ``Owner``, ``pkg::Owner.child.grandchild`` → ``pkg::Owner``): the package
    prefix plus the first dotted segment. ``None`` for a degenerate ref (fewer
    than two segments or any empty segment). Mirrors the TS
    ``parseChildTargetingRef().ownerRef``."""
    last_sep = ref.rfind(PACKAGE_SEP)
    seg_start = 0 if last_sep < 0 else last_sep + len(PACKAGE_SEP)
    parts = ref[seg_start:].split(".")
    if len(parts) < 2 or any(not p for p in parts):
        return None
    return ref[:seg_start] + parts[0]


_OVER_DROP = object()


def _try_resolve(
    ref: str,
    context_pkg: str | None,
    index: dict[str, MetaData],
    referrer_type: str | None = None,
):
    """:func:`_resolve`, with a ``..::`` over-drop returned as the ``_OVER_DROP`` marker
    (ADR-0059 R2: a bad value, not a missing target)."""
    try:
        return _resolve(ref, context_pkg, index, referrer_type)
    except RefOverDropError:
        return _OVER_DROP


def _resolve(
    ref: str,
    context_pkg: str | None,
    index: dict[str, MetaData],
    referrer_type: str | None = None,
) -> MetaData | None:
    """Resolve a super_ref string against the top-level index (ADR-0059 R2).

    Plain forms go through ``owner_candidate_keys``: ``::pkg::Name`` root-absolute,
    ``..::rest`` parent-relative (raises ``RefOverDropError`` on over-drop),
    ``pkg::Name`` exact, bare ``Name`` in the context package then root-level.

    A dotted ``Owner.child`` (FR-024, ADR-0029) resolves the OWNER the same way, then
    selects the child among the owner's EFFECTIVE children (so inherited children
    resolve) by name + the REFERRER's type. Multi-dot traverses child names to any
    depth (intermediate segments by unique name); degenerate empty segments, or no
    ``referrer_type``, resolve to ``None``.
    """
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

    # ADR-0059 R2: a plain ref binds one top-level node by its form -- the same
    # candidate keys every other reference uses. Raises RefOverDropError on over-drop.
    for key in owner_candidate_keys(ref, context_pkg or ""):
        hit = index.get(key)
        if hit is not None:
            return hit
    return None
