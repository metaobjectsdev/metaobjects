"""An own child may be shadowed by its SUPER's child — never by a later own SIBLING.

This pins a core `MetaData` defect that was Python-only and that no test could see.
`_effective_children_inner` appended a non-shadowing own child to `result` INSIDE the
matching loop, which made it eligible to be matched — and overwritten — by a later own
sibling. `extends` decides what a child overrides; a sibling is not a super.

WHY IT MATTERED, and why the shape is not exotic. Two children collide on a
`(type, name)` pair most easily when BOTH ARE UNNAMED, and the everyday model that
declares two unnamed children of one type is a WRITE-THROUGH ENTITY: a
`source.rdb @role: primary` for writes and a `source.rdb @role: replica` for reads.
On any such entity that also has a super, the primary was dropped from `children()`
outright. Measured on the fixture below before the fix:

    resolving sources: [('replica', 'acct_vw')]     # the PRIMARY is gone
    primary_rdb_source: None

`primary_rdb_source` reads `children()`, so the cost was not cosmetic: no table for the
router or the filter allowlist, no names module, and `ObjectManager` falling through to
the replica view. TypeScript (`meta-data.ts::_effectiveChildren`) and C#
(`MetaData.cs::EffectiveChildren`) both use an append queue and have always been
correct; this port was the only one of the three that was not.

WHY THIS FILE EXISTS AT ALL. The fix landed with the names restructure and the full
504-test codegen suite passed identically with it REVERTED — the defect was real,
severe, and pinned by nothing. A fix no test can see is a fix that comes back.
"""
from __future__ import annotations

import json

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.source_resolution import primary_rdb_source

# A write-through entity that ALSO has a super. Both halves are load-bearing: with no
# super, `_effective_children_inner` returns the own list untouched and the loop never
# runs; with no second unnamed source, nothing collides.
MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {
                "object.entity": {
                    "name": "Base",
                    "abstract": True,
                    "children": [{"field.long": {"name": "id"}}],
                }
            },
            {
                "object.entity": {
                    "name": "Acct",
                    "extends": "Base",
                    "children": [
                        {"source.rdb": {"@table": "acct_tbl", "@role": "primary"}},
                        {"source.rdb": {"@kind": "view", "@view": "acct_vw", "@role": "replica"}},
                        {"field.string": {"name": "memo"}},
                        {"identity.primary": {"name": "pk", "@fields": "id",
                                              "@generation": "increment"}},
                    ],
                }
            },
        ],
    }
}


def _acct():
    result = MetaDataLoader(strict=True).load(
        [InMemoryStringSource(json.dumps(MODEL), format=MetaDataFormat.JSON, id="wt.json")]
    )
    assert [str(e) for e in result.errors] == []
    return next(c for c in result.root.children() if c.name == "Acct")


def test_two_unnamed_sources_both_survive_effective_resolution() -> None:
    acct = _acct()
    sources = [(c.role(), c.physical_name()) for c in acct.children() if c.type == "source"]
    # Order is the declaration order, and both roles are present. Before the fix this
    # was [('replica', 'acct_vw')] — the primary silently overwritten by its sibling.
    assert sources == [("primary", "acct_tbl"), ("replica", "acct_vw")]


def test_the_primary_source_is_still_reachable() -> None:
    # The consequence, asserted separately from the cause: every downstream consumer
    # reaches the write table through this one lookup, and it returned None.
    source = primary_rdb_source(_acct())
    assert source is not None
    assert source.physical_name() == "acct_tbl"


def test_an_own_child_still_shadows_its_SUPERS_child() -> None:
    # The other direction, so a "fix" that simply stopped shadowing would fail here.
    # `id` is declared on Base and redeclared on the child with a @column; the child's
    # must win, and there must be exactly one of it.
    model = json.loads(json.dumps(MODEL))
    model["metadata.root"]["children"][1]["object.entity"]["children"].append(
        {"field.long": {"name": "id", "@column": "acct_pk"}}
    )
    result = MetaDataLoader(strict=True).load(
        [InMemoryStringSource(json.dumps(model), format=MetaDataFormat.JSON, id="wt2.json")]
    )
    assert [str(e) for e in result.errors] == []
    acct = next(c for c in result.root.children() if c.name == "Acct")
    ids = [c for c in acct.children() if c.type == "field" and c.name == "id"]
    assert len(ids) == 1
    assert ids[0].attrs().get("column") == "acct_pk"
