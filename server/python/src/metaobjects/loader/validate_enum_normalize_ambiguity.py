"""Authoring guard — enum vocabularies ambiguous under ``@normalize: strip``.

Code:
    * ``WARN_ENUM_NORMALIZE_AMBIGUOUS`` — a ``field.enum`` whose ``@values``
      contains a member equal to the concatenation of two or more OTHER members
      once normalized.

``strip`` (the DEFAULT mode) upper-cases and keeps only ``[A-Z0-9]``, erasing
every separator. That is what makes ``"SOCIAL-ATTACK"`` match the member
``SOCIAL_ATTACK`` — the desired behavior. But it also collapses a DELIMITED value
into one token, and if that token equals another member the extract engine coerces
it SUCCESSFULLY::

    values = {READ, WRITE, READWRITE};  input "read|write"  ->  READWRITE

The field is reported EXTRACTED (not MALFORMED) carrying a plausible, wrong value
— wrong-and-green. It is detectable from metadata alone, so the loader warns the
author at declaration time.

WARNING, not error: such a vocabulary is legal and completely unambiguous for
exact matching. ``collapse`` folds only ``[\\s_-]+`` and ``none`` folds nothing,
so neither can merge tokens across a delimiter like ``"|"`` — both are skipped.

Mirrors the TS reference
``packages/metadata/src/core/field/validate-enum-normalize-ambiguity.ts``.
"""
from __future__ import annotations

from ..meta.meta_data import MetaData
from ..meta.core.field.field_constants import (
    FIELD_ATTR_NORMALIZE,
    FIELD_ATTR_VALUES,
    FIELD_SUBTYPE_ENUM,
    NORMALIZE_DEFAULT,
)
from ..shared.base_types import TYPE_FIELD, TYPE_OBJECT
from ..source.error_source import LoaderWarning

WARN_ENUM_NORMALIZE_AMBIGUOUS = "WARN_ENUM_NORMALIZE_AMBIGUOUS"


def _strip_normalize(s: str) -> str:
    """``strip`` normalization: ASCII upper-case, then keep only ``[A-Z0-9]``.

    Mirrors the extract engine's ``Normalize.STRIP`` exactly — the two must agree
    or the guard warns about collisions the engine does not have (and misses ones
    it does)."""
    return "".join(c for c in s.upper() if ("A" <= c <= "Z") or ("0" <= c <= "9"))


def _segment_into(target: str, dict_entries: list[tuple[str, str]]) -> list[str] | None:
    """Word-break: can *target* be segmented into two or more dictionary entries?

    Returns the member names in order, or ``None``. Word-break rather than a
    pairwise scan so a three-way collision (A + B + C == ABC) is caught too.
    O(len^2 * |dict|) — trivial at vocabulary sizes and deterministic, which
    matters because every port must produce the identical warning."""
    n = len(target)
    best: list[list[str] | None] = [None] * (n + 1)
    best[0] = []
    for i in range(n):
        prefix = best[i]
        if prefix is None:
            continue
        for member, stripped in dict_entries:
            end = i + len(stripped)
            if end > n or not target.startswith(stripped, i):
                continue
            cand = prefix + [member]
            cur = best[end]
            if cur is None or len(cand) < len(cur):
                best[end] = cand
    full = best[n]
    # Two or more segments: a single-segment match is just another member that
    # strips to the same string — a different (duplicate) concern.
    return full if full is not None and len(full) >= 2 else None


def _effective_normalize(field: MetaData) -> str:
    """Effective ``@normalize``: own/inherited -> owning object -> default."""
    # ADR-0039: attrs() RESOLVES (Python naming inversion) — an enum extending an
    # abstract enum must see the super's @normalize.
    mode = field.attrs().get(FIELD_ATTR_NORMALIZE)
    if isinstance(mode, str):
        return mode
    parent = field.parent
    if parent is not None and parent.type == TYPE_OBJECT:
        obj_mode = parent.attrs().get(FIELD_ATTR_NORMALIZE)
        if isinstance(obj_mode, str):
            return obj_mode
    return NORMALIZE_DEFAULT


def validate_enum_normalize_ambiguity(
    root: MetaData,
    envelope_warnings: list[LoaderWarning] | None = None,
    legacy_warnings: list[str] | None = None,
) -> None:
    def visit(node: MetaData) -> None:
        if node.type == TYPE_FIELD and node.sub_type == FIELD_SUBTYPE_ENUM:
            # ADR-0039 sanctioned own: check the vocabulary DECLARED here. A
            # concrete enum inheriting @values shares the super's member set,
            # already checked at the super — one hazard yields one warning, not
            # one per referring field.
            raw = node.own_attrs().get(FIELD_ATTR_VALUES)
            if isinstance(raw, list) and len(raw) > 1:
                if _effective_normalize(node) == NORMALIZE_DEFAULT:
                    entries = [(str(m), _strip_normalize(str(m))) for m in raw]
                    for i, (member, stripped) in enumerate(entries):
                        if not stripped:
                            continue  # e.g. "_" — nothing to collide with
                        # Exclude self BY INDEX, not by value: two distinct members
                        # can strip to the same string (a separate concern).
                        others = [
                            e for j, e in enumerate(entries) if j != i and e[1]
                        ]
                        seg = _segment_into(stripped, others)
                        if seg is not None:
                            plus = " + ".join(f"'{s}'" for s in seg)
                            delimited = "|".join(s.lower() for s in seg)
                            msg = (
                                f'field.enum "{node.name}" member \'{member}\' is the '
                                f"concatenation of {plus} under @{FIELD_ATTR_NORMALIZE}: "
                                f"'{NORMALIZE_DEFAULT}' (the default), which erases "
                                f'separators. A delimited value such as "{delimited}" '
                                f"would coerce silently to '{member}' and be reported as "
                                f"extracted rather than malformed. Set "
                                f"@{FIELD_ATTR_NORMALIZE}: 'collapse' on this field if it "
                                f"can receive delimited input."
                            )
                            if envelope_warnings is not None:
                                envelope_warnings.append(
                                    LoaderWarning(
                                        code=WARN_ENUM_NORMALIZE_AMBIGUOUS,
                                        message=msg,
                                        source=node.source,
                                    )
                                )
                            if legacy_warnings is not None:
                                legacy_warnings.append(WARN_ENUM_NORMALIZE_AMBIGUOUS)
                            break  # one warning per declaring node
        # ADR-0039 sanctioned own: structural walk of what each node declares;
        # resolving children would re-visit inherited nodes at every referrer.
        for child in node.own_children():
            visit(child)

    visit(root)
