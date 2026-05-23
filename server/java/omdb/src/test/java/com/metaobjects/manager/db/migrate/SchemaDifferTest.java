package com.metaobjects.manager.db.migrate;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class SchemaDifferTest {
    private final SchemaDiffer differ = new SchemaDiffer();

    private ColumnDescriptor c(String n, SqlType t) { return new ColumnDescriptor(n, t, true, null); }
    private TableDescriptor program(ColumnDescriptor... cols) {
        return new TableDescriptor("program", null, List.of(cols), List.of(), List.of(), List.of("id"));
    }
    private SchemaSnapshot snap(TableDescriptor... t) { return new SchemaSnapshot(List.of(t), List.of()); }

    @Test public void missing_table_create_table() {
        DiffResult r = differ.diff(snap(program(c("id", new SqlType.Int(64)))), snap(), new AllowOptions(), RenameHints.empty());
        assertEquals(1, r.changes().size());
        assertTrue(r.changes().get(0) instanceof Change.CreateTable);
    }
    @Test public void missing_column_add_column() {
        SchemaSnapshot exp = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(120))));
        SchemaSnapshot act = snap(program(c("id", new SqlType.Int(64))));
        DiffResult r = differ.diff(exp, act, new AllowOptions(), RenameHints.empty());
        assertEquals(1, r.changes().size());
        assertEquals("title", ((Change.AddColumn) r.changes().get(0)).column().name());
    }
    @Test public void longer_varchar_change_column_type_allowed() {
        SchemaSnapshot exp = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(400))));
        SchemaSnapshot act = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(120))));
        DiffResult r = differ.diff(exp, act, new AllowOptions(), RenameHints.empty());
        assertEquals(1, r.changes().size());
        assertTrue(r.changes().get(0) instanceof Change.ChangeColumnType);
        assertEquals("allowed", r.changes().get(0).status().state());   // widening
    }
    @Test public void extra_actual_column_drop_blocked_by_default() {
        SchemaSnapshot exp = snap(program(c("id", new SqlType.Int(64))));
        SchemaSnapshot act = snap(program(c("id", new SqlType.Int(64)), c("legacy", new SqlType.Text(50))));
        DiffResult r = differ.diff(exp, act, new AllowOptions(), RenameHints.empty());
        assertEquals(1, r.changes().size());
        assertTrue(r.changes().get(0) instanceof Change.DropColumn);
        assertEquals("blocked", r.changes().get(0).status().state());
        assertEquals(1, r.blocked().size());
    }
    @Test public void previousName_hint_rename_not_drop_plus_add() {
        SchemaSnapshot exp = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(120))));
        SchemaSnapshot act = snap(program(c("id", new SqlType.Int(64)), c("name", new SqlType.Text(120))));
        RenameHints h = new RenameHints(); h.addColumnRename("program", "title", "name");
        DiffResult r = differ.diff(exp, act, new AllowOptions(), h);
        assertEquals(1, r.changes().size());
        Change.RenameColumn rc = (Change.RenameColumn) r.changes().get(0);
        assertEquals("name", rc.from());
        assertEquals("title", rc.to());
    }
    @Test public void identical_empty_diff() {
        SchemaSnapshot s = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(120))));
        assertTrue(differ.diff(s, s, new AllowOptions(), RenameHints.empty()).isEmpty());
    }
    @Test public void deterministic_regardless_of_input_order() {
        TableDescriptor a = program(c("id", new SqlType.Int(64)));
        TableDescriptor b = new TableDescriptor("subscriber", null, List.of(c("id", new SqlType.Int(64))),
            List.of(), List.of(), List.of("id"));
        List<String> k1 = keys(differ.diff(new SchemaSnapshot(List.of(a, b), List.of()), snap(), new AllowOptions(), RenameHints.empty()));
        List<String> k2 = keys(differ.diff(new SchemaSnapshot(List.of(b, a), List.of()), snap(), new AllowOptions(), RenameHints.empty()));
        assertEquals(k1, k2);
    }
    private List<String> keys(DiffResult r) { return r.changes().stream().map(Change::sortKey).toList(); }
}
