"""FR-037 R1 — the ``@mutability`` tightening order is load-bearing, so it is pinned.

``_rank()`` in ``loader/validate_field_mutability.py`` is an INDEX comparison over
``MUTABILITY_MODES`` ("declaration order IS the order", as its own docstring says), so
reordering that tuple silently inverts "may only tighten" with nothing to catch it.

The shared conformance corpus cannot stand in for this pin. Its inheritance fixtures pair
only ``readOnly`` with ``readWrite`` — the two ENDPOINTS — so a full reversal is caught but
a reorder that moves ONLY ``writeOnce`` is not. ``error-field-mutability-downgrade-writeonce``
closes the behavioural half cross-port; this closes the structural half in the port whose
rank function reads the tuple.

Mirrors the TypeScript pin (``metadata/test/fr037-field-mutability.test.ts`` — "declaration
order IS the tightening order"), which was the only such pin in any port until now.
"""

from metaobjects.meta.core.field.field_constants import (
    MUTABILITY_MODES,
    MUTABILITY_READ_ONLY,
    MUTABILITY_READ_WRITE,
    MUTABILITY_WRITE_ONCE,
)


def test_mutability_modes_declaration_order_is_the_tightening_order() -> None:
    # Loosest first. The downgrade rule is `rank(child) >= rank(parent)`, so this
    # order is the rule.
    assert tuple(MUTABILITY_MODES) == ("readWrite", "writeOnce", "readOnly")


def test_mutability_mode_spellings() -> None:
    # The wire spellings travel cross-port; a typo here is a silent divergence.
    assert MUTABILITY_READ_WRITE == "readWrite"
    assert MUTABILITY_WRITE_ONCE == "writeOnce"
    assert MUTABILITY_READ_ONLY == "readOnly"


def test_write_once_ranks_between_the_two_endpoints() -> None:
    """The specific relationship the corpus never exercises.

    Stated as an explicit rank comparison rather than inferred from the tuple above, so
    that a future change which keeps the tuple's CONTENTS but alters how rank is derived
    still fails here.
    """
    rank = list(MUTABILITY_MODES).index
    assert rank(MUTABILITY_READ_WRITE) < rank(MUTABILITY_WRITE_ONCE) < rank(MUTABILITY_READ_ONLY)
