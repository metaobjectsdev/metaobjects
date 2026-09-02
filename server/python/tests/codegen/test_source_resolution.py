"""Task 8 — one primary-source resolver, not four with two answers.

The runtime (``ObjectManager._table_name``) filters ``source.rdb`` children on
``@role: primary``. The three codegen copies (router generator, filter-allowlist
generator, M:N descriptor resolver) each took the FIRST ``source.*`` child, with
no role filter at all. On any entity declaring a ``@role: replica`` source those
two predicates disagree about which table the entity physically lives in — and
the runtime is the one that reads the rows back.

``metaobjects.source_resolution`` is the one resolver every codegen
caller (and Task 9's names generator) must go through from here on.
"""
from __future__ import annotations

import json

import pytest

from metaobjects import load_string
from metaobjects.source_resolution import (
    find_primary_writable_source,
    primary_rdb_source,
    resolve_table_name,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.persistence.source.source_constants import SOURCE_ROLE_PRIMARY
from metaobjects.runtime import ObjectManager
from metaobjects.shared.base_types import TYPE_OBJECT

_META = {
    "metadata.root": {
        "package": "acme::resolvers",
        "children": [
            # The discriminating shape: a @role:"replica" source declared BEFORE
            # the @role:"primary" one. A first-child scan (the bug the three
            # codegen copies carried) picks the replica; the role-filtered
            # resolver must pick the primary regardless of declaration order.
            # Neither source names its own physical slot, so the primary falls
            # through MetaSource.physical_name()'s step 4 (owning entity name,
            # pluralized) -- "replica_firsts" -- while the replica is given an
            # explicit, obviously-different @view so a first-child scan is
            # caught red-handed rather than accidentally agreeing.
            {
                "object.entity": {
                    "name": "ReplicaFirst",
                    "children": [
                        {
                            "source.rdb": {
                                "@role": "replica",
                                "@kind": "view",
                                "@view": "replica_first_reporting_view",
                            }
                        },
                        {"source.rdb": {"@role": "primary"}},
                        {"field.long": {"name": "id"}},
                        {
                            "identity.primary": {
                                "@fields": ["id"],
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            },
            # Normal declaration order, single source -- the no-churn control.
            {
                "object.entity": {
                    "name": "Widget",
                    "children": [
                        {"source.rdb": {"@table": "widgets"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "label", "@required": True}},
                        {
                            "identity.primary": {
                                "@fields": ["id"],
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            },
            # Normal declaration order with BOTH roles present, primary first --
            # proves the fix filters by role rather than merely "not the first
            # one", which a sloppier fix (e.g. "last child wins") could fake.
            {
                "object.entity": {
                    "name": "PrimaryFirst",
                    "children": [
                        {"source.rdb": {"@role": "primary", "@table": "primary_firsts"}},
                        {
                            "source.rdb": {
                                "@role": "replica",
                                "@kind": "view",
                                "@view": "v_primary_firsts",
                            }
                        },
                        {"field.long": {"name": "id"}},
                        {
                            "identity.primary": {
                                "@fields": ["id"],
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            },
            # #248 -- an object.value has NO identity, NO source, ever. The
            # structural shape of "no declared primary source at all", tied to
            # a real taxonomy rule rather than an artificial omission.
            {
                "object.value": {
                    "name": "AddressValue",
                    "children": [
                        {"field.string": {"name": "street"}},
                        {"field.string": {"name": "city"}},
                    ],
                }
            },
        ],
    }
}


def _load() -> tuple[MetaRoot, dict[str, MetaObject]]:
    result = load_string(json.dumps(_META))
    assert not result.errors, "; ".join(f"{e.code}: {e.message}" for e in result.errors)
    root = result.root
    entities = {
        c.name: c
        for c in root.children()
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
    }
    return root, entities


def test_primary_wins_over_a_replica_declared_first() -> None:
    _, entities = _load()
    entity = entities["ReplicaFirst"]

    src = primary_rdb_source(entity)
    assert src is not None
    assert src.role() == SOURCE_ROLE_PRIMARY

    name = resolve_table_name(entity)
    assert name == "replica_firsts"
    # Paired negative: a first-child scan (the old bug) would return this instead.
    assert name != "replica_first_reporting_view"


def test_no_primary_source_resolves_to_none() -> None:
    # #248 -- participation derives from a declared primary source, never the
    # object subtype.
    _, entities = _load()
    address = entities["AddressValue"]
    assert primary_rdb_source(address) is None
    assert resolve_table_name(address) is None


def test_codegen_and_runtime_agree_on_every_sourced_entity() -> None:
    """The property that matters is AGREEMENT, not either answer alone.
    ``ObjectManager._table_name`` already filtered by role; the generators did
    not. Pin them together on a model containing the divergent
    (replica-declared-first) shape so they cannot drift apart again.

    Scoped to entities that declare a primary source: ``resolve_table_name``'s
    contract for "no primary source" is ``None`` (see
    ``test_no_primary_source_resolves_to_none``), while
    ``ObjectManager._table_name`` -- a private runtime helper only ever called
    internally on entities the caller already knows are persistable -- falls
    back to the bare entity name for that case instead. That's a deliberate
    difference in what the two return for a NON-participating object, not a
    disagreement about which source is primary for one that has one -- which
    is the property this test exists to pin.
    """
    root, entities = _load()
    om = ObjectManager(root, driver=None)  # type: ignore[arg-type]

    checked = 0
    for entity in entities.values():
        if primary_rdb_source(entity) is None:
            continue
        assert resolve_table_name(entity) == om._table_name(entity), entity.name
        checked += 1

    # Guard against the loop silently checking nothing (e.g. an empty fixture).
    assert checked == 3  # ReplicaFirst, Widget, PrimaryFirst


def test_divergent_primary_and_writable_sources_is_refused_naming_both() -> None:
    """R32 — cross-port parity with C#'s ``CSharpNaming.ResolveObjectNames`` / TS's
    ``resolveObjectNames``: an object whose primary source and primary WRITABLE
    source resolve to two DIFFERENT physical names must be refused, not silently
    resolved to whichever the loose (any-role-primary) scan happens to find first.

    This is NOT a hypothetical fabricated to force a throw — it is a genuinely
    REACHABLE shape, loaded through the real loader with no validation bypassed.
    ``_validate_one_primary_source`` (above) enforces "exactly one primary" over
    ``own_children()`` only, and effective-``children()`` resolution shadows an
    own child over a super child only on a (type, name) match — two
    ``source.rdb`` children with DIFFERENT explicit names never collide. An
    ``object.base`` (the registered "abstract template, no runtime semantics"
    subtype — see ``object_constants.SUBTYPE_BASE``... via
    ``metaobjects.shared.base_types.SUBTYPE_BASE``) carries NONE of the
    subtype-specific structural rules the entity/value/projection branches
    enforce — in particular, ``_validate_one_primary_source``'s own
    ``ERR_ENTITY_PRIMARY_SOURCE_READONLY`` branch is scoped to
    ``OBJECT_SUBTYPE_ENTITY`` and never fires for ``object.base``, so an
    abstract ``object.base`` parent's own READ-ONLY primary source and a
    concrete-ish ``object.base`` child's own, differently-named, WRITABLE
    primary source both survive on the child's effective ``children()`` at
    once. This model loads with ZERO errors.

    Mirrors C#'s ``NamesGeneratorTests.
    A_divergent_primary_and_writable_source_pair_is_refused_naming_both`` shape
    for shape (same package-free names, same physical names, same wording) —
    this is the SAME reachable divergence C#/TS already gate, not a Python-only
    construction.
    """
    model = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.base": {
                        "name": "ParentWeird",
                        "abstract": True,
                        "children": [
                            {
                                "source.rdb": {
                                    "name": "viewSrc",
                                    "@kind": "view",
                                    "@view": "v_parent",
                                    "@role": "primary",
                                }
                            },
                            {"field.int": {"name": "id"}},
                        ],
                    }
                },
                {
                    "object.base": {
                        "name": "ChildWeird",
                        "extends": "ParentWeird",
                        "children": [
                            {
                                "source.rdb": {
                                    "name": "tableSrc",
                                    "@table": "child_table",
                                    "@role": "primary",
                                }
                            },
                        ],
                    }
                },
            ],
        }
    }
    result = load_string(json.dumps(model))
    assert not result.errors, "; ".join(f"{e.code}: {e.message}" for e in result.errors)
    root = result.root
    child = next(c for c in root.children() if c.name == "ChildWeird")
    assert isinstance(child, MetaObject)

    # Documents the shape: two real, different, defined physical names — not a
    # None vs. a string (contrast "a read-only primary beside a writable
    # REPLICA on ONE object", which is legal and never reaches this guard: the
    # replica isn't role=primary at all, so find_primary_writable_source and
    # primary_rdb_source agree by construction).
    writable = find_primary_writable_source(child)
    assert writable is not None
    assert writable.physical_name() == "child_table"

    with pytest.raises(ValueError) as exc_info:
        primary_rdb_source(child)
    message = str(exc_info.value)
    # All three substrings asserted separately, so a message dropping one still fails.
    assert "ChildWeird" in message
    assert "v_parent" in message
    assert "child_table" in message
