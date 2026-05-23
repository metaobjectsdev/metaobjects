package com.metaobjects.manager.db.migrate;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class SchemaSnapshotTest {
    @Test public void holds_tables_and_resolves_by_identity() {
        ColumnDescriptor id = new ColumnDescriptor("id", new SqlType.Int(64), false, null);
        TableDescriptor program = new TableDescriptor("program", null, List.of(id),
            List.of(), List.of(), List.of("id"));
        SchemaSnapshot snap = new SchemaSnapshot(List.of(program), List.of());
        assertEquals(1, snap.tables().size());
        assertEquals("program", snap.tables().get(0).name());
        assertFalse(program.columns().isEmpty());
    }
}
