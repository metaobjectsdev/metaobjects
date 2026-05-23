package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.migrate.SchemaSnapshot.*;
import java.util.*;

/**
 * Compares an EXPECTED snapshot (metadata) against an ACTUAL snapshot (introspection) and produces
 * the deterministic change list to bring actual -> expected (port of migrate-ts diff). The rename
 * mechanism is @previousName hints (Java v1) rather than the TS heuristic. Status is applied last.
 */
public final class SchemaDiffer {

    public DiffResult diff(SchemaSnapshot expected, SchemaSnapshot actual, AllowOptions allow, RenameHints hints) {
        List<Change> changes = new ArrayList<>();
        Map<String, TableDescriptor> exp = byName(expected.tables());
        Map<String, TableDescriptor> act = byName(actual.tables());

        for (TableDescriptor e : expected.tables()) {
            String key = e.name().toLowerCase();
            TableDescriptor a = act.get(key);
            if (a == null) {
                // table rename hint? (old table present, new absent)
                String prev = hints.previousTable(e.name());
                TableDescriptor prevTable = prev == null ? null : act.get(prev.toLowerCase());
                if (prevTable != null) {
                    changes.add(new Change.RenameTable(prevTable.name(), e.name(), e.schema()));
                    diffColumns(e, prevTable, hints, changes);   // then converge columns of the renamed table
                } else {
                    changes.add(new Change.CreateTable(e));      // new table: columns ride with CREATE TABLE
                }
            } else {
                diffColumns(e, a, hints, changes);
            }
        }
        // tables in actual but not expected -> drop-table (blocked by default via status)
        for (TableDescriptor a : actual.tables()) {
            if (!exp.containsKey(a.name().toLowerCase()) && !isRenameTarget(a, expected, hints)) {
                changes.add(new Change.DropTable(a.name(), a.schema()));
            }
        }
        // views: create when absent (origin->SQL derivation is Plan 4; here SQL is whatever the descriptor carries).
        // NB: actualTableNames holds actual TABLE names only — v1 does not introspect actual views, so an
        // expected view is treated as absent (always created) unless a table already occupies its name.
        Set<String> actualTableNames = new HashSet<>(act.keySet());
        for (ViewDescriptor v : expected.views()) {
            if (!actualTableNames.contains(v.name().toLowerCase())) changes.add(new Change.CreateView(v));
        }

        // NB: TS diff() relies on pass-generation order; Java adds an explicit, stable phase-sort
        // (Change.sortKey) for determinism — an intentional Java addition, not a divergence in output meaning.
        // Schema is NOT part of the table-identity key in v1 (all fixtures/Derby use null schema); Postgres
        // multi-schema identity (null<->"public" normalization) lands with the Postgres dialect work.
        changes.sort(Comparator.comparing(Change::sortKey));
        ChangeStatusRules.applyStatus(changes, allow);
        return new DiffResult(changes, changes.stream().filter(c -> c.status().isBlocked()).toList());
    }

    private void diffColumns(TableDescriptor e, TableDescriptor a, RenameHints hints, List<Change> changes) {
        Map<String, ColumnDescriptor> ecols = byColName(e.columns());
        Map<String, ColumnDescriptor> acols = byColName(a.columns());
        Set<String> consumed = new HashSet<>();

        for (ColumnDescriptor ec : e.columns()) {
            ColumnDescriptor ac = acols.get(ec.name().toLowerCase());
            if (ac == null) {
                String prevCol = hints.previousColumn(e.name(), ec.name());
                ColumnDescriptor prev = prevCol == null ? null : acols.get(prevCol.toLowerCase());
                if (prev != null) {
                    changes.add(new Change.RenameColumn(e.name(), e.schema(), prev.name(), ec.name()));
                    consumed.add(prev.name().toLowerCase());
                } else {
                    changes.add(new Change.AddColumn(e.name(), e.schema(), ec));
                }
                continue;
            }
            consumed.add(ac.name().toLowerCase());
            if (!ec.sqlType().equals(ac.sqlType())) {   // record equals == sqlTypeEquals
                changes.add(new Change.ChangeColumnType(e.name(), e.schema(), ec.name(), ac.sqlType(), ec.sqlType()));
            }
            // change-column-nullable / change-column-default: declared in the union but NOT produced in v1.
        }
        for (ColumnDescriptor ac : a.columns()) {
            if (!ecols.containsKey(ac.name().toLowerCase()) && !consumed.contains(ac.name().toLowerCase())) {
                changes.add(new Change.DropColumn(e.name(), e.schema(), ac.name()));
            }
        }
    }

    /** True if `a` is the old name of some expected table via a @previousName hint (so it's a rename, not a drop). */
    private boolean isRenameTarget(TableDescriptor a, SchemaSnapshot expected, RenameHints hints) {
        for (TableDescriptor e : expected.tables()) {
            String prev = hints.previousTable(e.name());
            if (prev != null && prev.equalsIgnoreCase(a.name())) return true;
        }
        return false;
    }

    private static Map<String, TableDescriptor> byName(List<TableDescriptor> ts) {
        Map<String, TableDescriptor> m = new LinkedHashMap<>();
        for (TableDescriptor t : ts) m.put(t.name().toLowerCase(), t);
        return m;
    }
    private static Map<String, ColumnDescriptor> byColName(List<ColumnDescriptor> cs) {
        Map<String, ColumnDescriptor> m = new LinkedHashMap<>();
        for (ColumnDescriptor c : cs) m.put(c.name().toLowerCase(), c);
        return m;
    }
}
