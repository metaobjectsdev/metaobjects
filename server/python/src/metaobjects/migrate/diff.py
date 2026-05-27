"""Diff two SchemaSnapshots → Change list. Bootstrap path (empty actual) only;
full column-aware diff is deferred until Python introspect ships."""
from __future__ import annotations

from .types import (
    AddColumn,
    AddFk,
    AddIndex,
    Change,
    ChangeStatus,
    CreateTable,
    CreateView,
    DropTable,
    SchemaSnapshot,
)


def diff(expected: SchemaSnapshot, actual: SchemaSnapshot) -> list[Change]:
    """Compare expected vs actual; produce the change list to bring actual → expected.

    v1 supports the bootstrap path (actual is empty): every expected table
    becomes a CreateTable + AddIndex + AddFk; every expected view becomes a
    CreateView. Tables in actual but not expected → DropTable (blocked by
    default — caller decides whether to surface that).
    """
    changes: list[Change] = []
    exp_tables = {(t.schema or "public", t.name.lower()): t for t in expected.tables}
    act_tables = {(t.schema or "public", t.name.lower()): t for t in actual.tables}

    for key, table in exp_tables.items():
        if key in act_tables:
            act_cols = {c.name.lower() for c in act_tables[key].columns}
            for col in table.columns:
                if col.name.lower() not in act_cols:
                    changes.append(AddColumn(table=table.name, schema=table.schema, column=col))
            continue
        changes.append(CreateTable(table=table))
        for idx in table.indexes:
            changes.append(AddIndex(table=table.name, schema=table.schema, index=idx))
        for fk in table.foreign_keys:
            changes.append(AddFk(table=table.name, schema=table.schema, fk=fk))

    for key, table in act_tables.items():
        if key not in exp_tables:
            # Drops are blocked by default — the corpus has a scenario
            # asserting this behavior. Status is "blocked" with the
            # cross-port-shared reason vocabulary.
            changes.append(DropTable(
                table=table.name,
                schema=table.schema,
                status=ChangeStatus(state="blocked", blocked_reason="pass allow.dropTable"),
            ))

    for view in expected.views:
        # Introspect-actual is empty in v1, so every expected view becomes a create.
        changes.append(CreateView(view=view))

    return changes
