"""Multi-file / overlay merge: fold parsed roots into one (post-parse, pre-super-resolve).

FR5c — the merge phase is the cross-port attribution hub. Tracks which
files contributed to each post-merge node and, on each ``_merge_into``
call:

  1. **ERR_MERGE_CONFLICT** — same ``@attr`` name set with different
     non-empty values on both contributors → hard error with a
     :class:`MergedSource` envelope listing both files and the conflicting
     attr's jsonPath. Last-writer-wins still applies to the merged tree.
  2. **MergedSource upgrade** — when the new contributor actually changed
     the post-merge canonical (semantic_diff returns True), the target's
     ``source`` envelope is upgraded to :class:`MergedSource` with
     alphabetically-sorted ``files``/``contributors`` (overlay-base for
     the first file, overlay-extension for the rest).
  3. **WARN_DUPLICATE_DECLARATION** — when the new contributor's content
     produced no semantic change AND the new file isn't already a
     contributor, emit a warning (string channel + envelope channel).
     The node's source is NOT upgraded — the warning surfaces the
     redundancy.

Cross-port contract (TS reference ``parser-core.ts``):
  * Alphabetical file order across contributors[] (matches DirectorySource
    sorting).
  * Single error code ``ERR_MERGE_CONFLICT``; per-attr provenance deferred.
  * "Conflict" = both sides set, both non-empty, values differ. Empty
    string and absent are NOT conflicts.
"""
from __future__ import annotations

import json
from typing import Optional

from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..serializer_json import canonical_serialize
from ..shared.separators import PACKAGE_SEP
from ..source import (
    Contributor,
    ErrorSource,
    JsonSource,
    LoaderWarning,
    MergedSource,
    WARN_DUPLICATE_DECLARATION,
    YamlSource,
)
from ..source.semantic_diff import semantic_diff


def merge_roots(
    roots: list[MetaData],
    errors: list[MetaError],
    warnings: Optional[list[str]] = None,
    envelope_warnings: Optional[list[LoaderWarning]] = None,
) -> MetaData:
    """Merge all roots into the first. Returns the merged root (or raises if empty).

    FR5c — *warnings* and *envelope_warnings*, when provided, receive
    :data:`WARN_DUPLICATE_DECLARATION` messages for duplicate-with-no-change
    contributions. They default to throwaway lists to preserve the prior
    `merge_roots(roots, errors)` two-arg signature for any in-tree caller
    that hasn't been updated yet.
    """
    if not roots:
        raise ValueError("merge_roots requires at least one root")
    if warnings is None:
        warnings = []
    if envelope_warnings is None:
        envelope_warnings = []
    target = roots[0]
    for src in roots[1:]:
        _merge_into(target, src, errors, warnings, envelope_warnings)
    return target


def _source_files(env: ErrorSource) -> tuple[str, ...]:
    """Extract the ``files`` tuple from any envelope that carries one.

    Returns an empty tuple for code / database envelopes (no file context).
    """
    if isinstance(env, (JsonSource, YamlSource, MergedSource)):
        return tuple(env.files)
    return ()


def _source_json_path(env: ErrorSource) -> Optional[str]:
    """Extract the ``json_path`` from any envelope that carries one."""
    if isinstance(env, (JsonSource, YamlSource, MergedSource)):
        return env.json_path
    return None


def _build_contributors(files: tuple[str, ...]) -> tuple[Contributor, ...]:
    """Build a contributors tuple — first file is overlay-base, rest are
    overlay-extension. *files* must already be deduplicated + sorted.
    """
    return tuple(
        Contributor(
            file=f,
            role="overlay-base" if i == 0 else "overlay-extension",
        )
        for i, f in enumerate(files)
    )


def _is_empty_value(v: object) -> bool:
    """Mirror TS ``isEmptyValue``: ``None``, ``""``, and ``[]`` are empty;
    everything else is set.
    """
    if v is None:
        return True
    if isinstance(v, str) and v == "":
        return True
    if isinstance(v, list) and not v:
        return True
    return False


def _attr_values_equal(a: object, b: object) -> bool:
    """Structural value equality matching TS ``attrValuesEqual``: scalars
    compared by ``==``; lists/dicts compared key-order-independently via a
    canonical-key-sorted JSON dump (the same substrate the canonical
    serializer + semantic_diff use).
    """
    if a == b:
        return True
    if isinstance(a, (list, dict)) and isinstance(b, (list, dict)):
        try:
            return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
        except (TypeError, ValueError):
            return False
    return False


def _detect_attr_merge_conflicts(
    target: MetaData,
    src: MetaData,
    errors: list[MetaError],
) -> None:
    """FR5c — for every own @-attr on *src*, check whether *target* already
    declares the same attr with a different non-empty value. If so, emit an
    ``ERR_MERGE_CONFLICT`` carrying a :class:`MergedSource` envelope naming
    both contributors.

    The merge itself proceeds (last-writer-wins) so the loader sees one
    canonical tree; the error surfaces the conflict.
    """
    target_files = _source_files(target.source)
    src_files = _source_files(src.source)
    target_json_path = _source_json_path(target.source)

    # ADR-0039 sanctioned own: overlay/merge operates on the DECLARED layers by
    # definition — it compares/combines each file's own attrs (never the resolved
    # effective view, which would confuse inherited attrs with authored ones).
    pre_attrs: dict[str, object] = {
        attr.name: getattr(attr, "value", None) for attr in target.own_meta_attrs()
    }

    for src_attr in src.own_meta_attrs():
        attr_name = src_attr.name
        if attr_name not in pre_attrs:
            continue
        existing_val = pre_attrs[attr_name]
        new_val = getattr(src_attr, "value", None)

        if _is_empty_value(new_val) or _is_empty_value(existing_val):
            continue
        if _attr_values_equal(existing_val, new_val):
            continue

        # Conflict — build the MergedSource envelope.
        combined = sorted(set(target_files) | set(src_files))
        conflict_files = tuple(combined)
        attr_path = (
            f"{target_json_path}.@{attr_name}"
            if target_json_path
            else f"@{attr_name}"
        )
        envelope = MergedSource(
            files=conflict_files,
            json_path=attr_path,
            contributors=_build_contributors(conflict_files),
        )
        errors.append(
            MetaError(
                f"attr '@{attr_name}' conflicts: existing value "
                f"{json.dumps(existing_val)} differs from new value "
                f"{json.dumps(new_val)} on {target.fqn()}",
                ErrorCode.ERR_MERGE_CONFLICT,
                envelope=envelope,
            )
        )


def _root_child_key(node: MetaData) -> str:
    """The package-qualified identity of a ROOT-LEVEL child for merge matching.

    ``<pkg>::<name>`` where pkg is the node's own ``package`` when declared,
    else its ``file_default_package`` (the declaring file's root package
    captured at parse time). Bare name when neither exists. Deliberately does
    NOT use :meth:`MetaData.resolution_key` — its ancestor-walk fallback would
    fold the MERGED root's (first file's) package onto a package-less child,
    skewing identity for later files in the merge sequence.
    """
    pkg = node.package or node.file_default_package
    return f"{pkg}{PACKAGE_SEP}{node.name}" if pkg else node.name


def _merge_into(
    target: MetaData,
    src: MetaData,
    errors: list[MetaError],
    warnings: list[str],
    envelope_warnings: list[LoaderWarning],
) -> None:
    """Merge *src*'s own attrs/children into *target* in place.

    FR5c — runs three diagnostics around the merge:
      1. ``ERR_MERGE_CONFLICT`` on conflicting @-attrs (before the write).
      2. ``MergedSource`` upgrade when the merge produced semantic change.
      3. ``WARN_DUPLICATE_DECLARATION`` when no semantic change occurred
         AND the contributor file is new.

    The root is intentionally excluded from FR5c diagnostics: it is a
    synthetic accumulator (every file declares ``metadata.root``), not an
    author-meaningful node. The merge attribution applies to
    ``object.entity`` / ``field.*`` / etc.
    """
    is_root = target.parent is None  # root has no parent
    fr5c_active = not is_root and target.name != ""

    pre_canonical: Optional[str] = None
    if fr5c_active:
        pre_canonical = canonical_serialize(target)
        _detect_attr_merge_conflicts(target, src, errors)

    # ADR-0039 sanctioned own: overlay/merge — accumulate each file's own attrs +
    # own children (declared-here layers) into the merged tree.
    # attrs: source overwrites target (last-writer-wins)
    for attr in src.own_meta_attrs():
        target.set_attr(attr.name, getattr(attr, "value", None), sub_type=attr.sub_type)
    # children: merge by (type, name), else append.
    #
    # ROOT-LEVEL matches are PACKAGE-QUALIFIED: two files declaring the same
    # (type, name) under different packages are DISTINCT root nodes, never a
    # merge pair (mirrors the Java parser, which searches root children by
    # "pkg::name"). Nested children stay bare-name matched — they are scoped
    # by their parent, and packages don't disambiguate siblings inside a node.
    for sc in src.own_children():
        tc = next(
            (
                c
                for c in target.own_children()
                if c.type == sc.type
                and c.name == sc.name
                and (not is_root or _root_child_key(c) == _root_child_key(sc))
            ),
            None,
        )
        if tc is not None:
            _merge_into(tc, sc, errors, warnings, envelope_warnings)
        else:
            if getattr(sc, "is_overlay", False):
                errors.append(
                    MetaError(
                        f"overlay node '{sc.fqn()}' has no merge target",
                        ErrorCode.ERR_OVERLAY_NO_TARGET,
                        path=sc.fqn(),
                    )
                )
            sc.parent = target
            target.add_child(sc)

    if not fr5c_active or pre_canonical is None:
        return

    # Post-merge: compare shapes and upgrade source / emit warning.
    post_canonical = canonical_serialize(target)
    pre_parsed = json.loads(pre_canonical)
    post_parsed = json.loads(post_canonical)
    changed = semantic_diff(pre_parsed, post_parsed)

    existing_env = target.source
    existing_files = list(_source_files(existing_env))
    src_files = list(_source_files(src.source))
    json_path = _source_json_path(existing_env)

    new_contributor_file = src_files[0] if src_files else "<unknown>"

    if changed:
        all_files = sorted(set(existing_files + src_files))
        merged_files = tuple(all_files)
        merged_env = MergedSource(
            files=merged_files,
            json_path=json_path if json_path is not None else "$",
            contributors=_build_contributors(merged_files),
        )
        target.set_source(merged_env)
    elif existing_files and new_contributor_file not in existing_files:
        # Identical re-declaration from a different file → warn.
        all_files = sorted(set(existing_files + [new_contributor_file]))
        warn_files = tuple(all_files)
        warn_env = MergedSource(
            files=warn_files,
            json_path=json_path if json_path is not None else "$",
            contributors=_build_contributors(warn_files),
        )
        message = f"duplicate declaration of {target.fqn()} with no semantic change"
        # Legacy string channel — what the conformance runner checks against
        # expected-warnings.json (a list[str]).
        warnings.append(message)
        # Envelope channel — typed code + source for downstream tooling.
        envelope_warnings.append(
            LoaderWarning(
                code=WARN_DUPLICATE_DECLARATION,
                message=message,
                source=warn_env,
            )
        )
