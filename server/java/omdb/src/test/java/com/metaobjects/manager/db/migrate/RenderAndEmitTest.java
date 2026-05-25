package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.driver.PostgresDriver;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class RenderAndEmitTest {
    private TableDescriptor program() {
        return new TableDescriptor("program", null,
            List.of(new ColumnDescriptor("id", new SqlType.Int(64), false, null),
                    new ColumnDescriptor("title", new SqlType.Text(120), true, null)),
            List.of(), List.of(), List.of("id"));
    }

    @Test public void postgres_renders_create_add_widen_rename() {
        PostgresDriver pg = new PostgresDriver();
        // Identifiers are double-quoted so mixed-case names round-trip through PG.
        assertTrue(pg.render(new Change.CreateTable(program())).startsWith("CREATE TABLE \"program\""));
        assertEquals("ALTER TABLE \"program\" ADD COLUMN \"title\" VARCHAR(120)",
            pg.render(new Change.AddColumn("program", null, new ColumnDescriptor("title", new SqlType.Text(120), true, null))));
        assertEquals("ALTER TABLE \"program\" ALTER COLUMN \"title\" TYPE VARCHAR(400)",
            pg.render(new Change.ChangeColumnType("program", null, "title", new SqlType.Text(120), new SqlType.Text(400))));
        assertEquals("ALTER TABLE \"program\" RENAME COLUMN \"name\" TO \"title\"",
            pg.render(new Change.RenameColumn("program", null, "name", "title")));
    }
    @Test public void derby_rename_uses_derby_grammar() {
        assertEquals("RENAME COLUMN program.name TO title",
            new DerbyDriver().render(new Change.RenameColumn("program", null, "name", "title")));
    }
    @Test public void emit_assembles_up_script_for_allowed_changes() {
        DiffResult r = new DiffResult(
            List.of(new Change.CreateTable(program(), Change.ChangeStatus.ALLOWED)), List.of());
        EmitResult out = new MigrationEmitter(new PostgresDriver()).emit(r);
        assertTrue(out.up().contains("CREATE TABLE"));
        assertEquals("", out.down());        // forward-only v1 (declared for shape parity)
    }
    @Test(expected = BlockedChangesError.class)
    public void emit_throws_on_blocked_changes() {
        Change blocked = new Change.DropColumn("program", null, "legacy")
            .withStatus(Change.ChangeStatus.blocked("destructive"));
        new MigrationEmitter(new PostgresDriver()).emit(new DiffResult(List.of(blocked), List.of(blocked)));
    }
}
