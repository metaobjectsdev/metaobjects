package com.metaobjects.manager.db.driver;

import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.NameDef;
import com.metaobjects.manager.db.defs.TableDef;
import org.junit.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

/** SQLiteDriver reads the key an AUTOINCREMENT column just generated, on the inserting connection. */
public class SQLiteDriverAutoIdTest {

    private static final class TestDriver extends SQLiteDriver {
        String lastAutoId(Connection c, ColumnDef col) throws SQLException { return getLastAutoId(c, col); }
    }

    private static ColumnDef idColumn() {
        ColumnDef col = new ColumnDef("id", Types.BIGINT);
        col.setBaseTable(new TableDef(new NameDef(null, "things")));
        return col;
    }

    @Test
    public void lastAutoIdIsTheKeyJustInserted() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:");
             Statement s = c.createStatement()) {
            s.execute("CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, name TEXT)");
            s.execute("INSERT INTO things (name) VALUES ('a')");
            s.execute("INSERT INTO things (name) VALUES ('b')");
            assertEquals("2", new TestDriver().lastAutoId(c, idColumn()));
        }
    }

    @Test
    public void lastAutoIdWithNoInsertIsRefused() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:")) {
            assertThrows(SQLException.class, () -> new TestDriver().lastAutoId(c, idColumn()));
        }
    }
}
