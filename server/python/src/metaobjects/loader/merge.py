"""Multi-file / overlay merge: fold parsed roots into one (post-parse, pre-super-resolve)."""
from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData


def merge_roots(roots: list[MetaData], errors: list[MetaError]) -> MetaData:
    """Merge all roots into the first. Returns the merged root (or raises if empty)."""
    if not roots:
        raise ValueError("merge_roots requires at least one root")
    target = roots[0]
    for src in roots[1:]:
        _merge_into(target, src, errors)
    return target


def _merge_into(target: MetaData, src: MetaData, errors: list[MetaError]) -> None:
    # attrs: source overwrites target (last-writer-wins)
    for attr in src.own_meta_attrs():
        target.set_attr(attr.name, getattr(attr, "value", None), sub_type=attr.sub_type)
    # children: merge by (type, name), else append
    for sc in src.children():
        tc = next(
            (c for c in target.children() if c.type == sc.type and c.name == sc.name),
            None,
        )
        if tc is not None:
            _merge_into(tc, sc, errors)
        else:
            if getattr(sc, "is_overlay", False):
                errors.append(
                    MetaError(
                        f"overlay node '{sc.effective_fqn()}' has no merge target",
                        ErrorCode.ERR_OVERLAY_NO_TARGET,
                        path=sc.effective_fqn(),
                    )
                )
            sc.parent = target
            target.add_child(sc)
