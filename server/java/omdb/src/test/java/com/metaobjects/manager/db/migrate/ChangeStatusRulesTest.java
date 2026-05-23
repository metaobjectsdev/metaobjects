package com.metaobjects.manager.db.migrate;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class ChangeStatusRulesTest {
    private ColumnDescriptor col(String n, SqlType t) { return new ColumnDescriptor(n, t, true, null); }

    @Test public void drop_column_blocked_unless_allowed() {
        List<Change> cs = new ArrayList<>(List.of(new Change.DropColumn("program", null, "legacy")));
        ChangeStatusRules.applyStatus(cs, new AllowOptions());
        assertEquals("blocked", cs.get(0).status().state());

        List<Change> cs2 = new ArrayList<>(List.of(new Change.DropColumn("program", null, "legacy")));
        ChangeStatusRules.applyStatus(cs2, AllowOptions.builder().dropColumn(true).build());
        assertEquals("allowed", cs2.get(0).status().state());
    }

    @Test public void widening_type_always_allowed_narrowing_blocked() {
        List<Change> widen = new ArrayList<>(List.of(
            new Change.ChangeColumnType("program", null, "title", new SqlType.Text(120), new SqlType.Text(400))));
        ChangeStatusRules.applyStatus(widen, new AllowOptions());
        assertEquals("allowed", widen.get(0).status().state());

        List<Change> narrow = new ArrayList<>(List.of(
            new Change.ChangeColumnType("program", null, "title", new SqlType.Text(400), new SqlType.Text(120))));
        ChangeStatusRules.applyStatus(narrow, new AllowOptions());
        assertEquals("blocked", narrow.get(0).status().state());
    }

    @Test public void additive_kinds_allowed() {
        List<Change> cs = new ArrayList<>(List.of(
            new Change.AddColumn("program", null, col("title", new SqlType.Text(120))),
            new Change.RenameColumn("program", null, "name", "title")));
        ChangeStatusRules.applyStatus(cs, new AllowOptions());
        assertTrue(cs.stream().allMatch(c -> "allowed".equals(c.status().state())));
    }
}
