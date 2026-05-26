"""FR5a / ADR-0009 — Cross-port-aligned semantic-equality compare for metadata
trees. Returns ``True`` if the two inputs differ in any semantically-meaningful
way (excluding ``source``, which is loader output).

Algorithm (ADR-0009 §semantic_diff):

    1. Sort attrs lexicographically; compare attr-by-attr; values by canonical
       structural equality (key-order independent, whitespace-insensitive).
    2. Children are compared as ordered sequences.
    3. Reserved structural keys (``name``, ``package``, ``extends``,
       ``abstract``, ``overlay``, ``isArray``, ``value``) participate like attrs.
    4. ``source`` excluded from the diff.

FR5a does not exercise this — FR5c will consume the boolean to drive the
duplicate-with-no-change ``WARN_DUPLICATE_DECLARATION`` path. We ship the
skeleton + tests now so the port is ready when FR5c lands.

Mirrors:
    * TS  — `server/typescript/packages/metadata/src/semantic-diff.ts`
    * C#  — `server/csharp/MetaObjects/Source/SemanticDiff.cs`
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Union

if TYPE_CHECKING:  # avoid an import cycle (MetaData imports `..source`).
    from ..meta.meta_data import MetaData

# Keys excluded from the structural diff: ``source`` is loader output, not
# metadata. Documented for parity with the C# constant set.
_EXCLUDED_KEYS: frozenset[str] = frozenset({"source"})

JsonValue = Union[None, bool, int, float, str, list[Any], dict[str, Any]]


def semantic_diff(a: "Union[MetaData, JsonValue]", b: "Union[MetaData, JsonValue]") -> bool:
    """Return ``True`` when *a* and *b* differ in any semantically-meaningful
    way; otherwise ``False``.

    Inputs may be:
        * Two :class:`MetaData` instances — both are serialized to canonical
          JSON and the resulting trees are compared. Useful for the
          overlay-merge consumer in FR5c.
        * Two raw JSON values (dict / list / scalar) — compared directly.
    """
    # Lazy import to break the meta_data ↔ source cycle: MetaData imports
    # `..source` at module load to default `_source` to CodeSource.DEFAULT.
    from ..meta.meta_data import MetaData as _MetaData
    from ..serializer_json import canonical_serialize

    if isinstance(a, _MetaData) and isinstance(b, _MetaData):
        serialized_a = canonical_serialize(a)
        serialized_b = canonical_serialize(b)
        # Fast path: byte-identical canonical output → no diff.
        if serialized_a == serialized_b:
            return False
        return not _equal(json.loads(serialized_a), json.loads(serialized_b))
    # Raw-value path.
    return not _equal(a, b)


def _equal(a: Any, b: Any) -> bool:  # noqa: ANN401 — recursive JSON value compare
    """Structural equality with the ADR-0009 rules: key-order independent for
    dicts; ordered for lists; ``source`` excluded; values compared via Python
    equality (which collapses ``True == 1`` etc. — matches the TS/C# behaviour
    where canonical-JSON output is the comparison substrate).
    """
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False

    if isinstance(a, dict) and isinstance(b, dict):
        a_keys = sorted(k for k in a if k not in _EXCLUDED_KEYS)
        b_keys = sorted(k for k in b if k not in _EXCLUDED_KEYS)
        if a_keys != b_keys:
            return False
        for k in a_keys:
            if not _equal(a[k], b[k]):
                return False
        return True

    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        for ai, bi in zip(a, b):
            if not _equal(ai, bi):
                return False
        return True

    # Scalars / mismatched container types fall through to value equality.
    # bool / int collapse the way Python does (True == 1) — matches what the TS
    # / C# canonical-JSON byte-compare produces on whole-number floats etc.
    return bool(a == b)


__all__ = ["semantic_diff"]
