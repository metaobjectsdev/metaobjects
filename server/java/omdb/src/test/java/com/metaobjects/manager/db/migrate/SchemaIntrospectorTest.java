package com.metaobjects.manager.db.migrate;

import org.junit.*;
import java.sql.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class SchemaIntrospectorTest {
    private static String dbFile;

    private static Connection conn() throws SQLException {
        return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
    }

    @BeforeClass
    public static void setup() throws Exception {
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        dbFile = "introspect-" + System.currentTimeMillis();
        try (Connection c = conn(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE PROGRAM (ID BIGINT NOT NULL PRIMARY KEY, TITLE VARCHAR(120))");
        }
    }

    @AfterClass
    public static void teardown() throws Exception {
        try {
            DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true");
        } catch (SQLException ignored) {}
    }

    private TableDescriptor table(SchemaSnapshot s, String name) {
        return s.tables().stream()
                .filter(t -> t.name().equalsIgnoreCase(name))
                .findFirst()
                .orElse(null);
    }

    private ColumnDescriptor col(TableDescriptor t, String name) {
        return t.columns().stream()
                .filter(c -> c.name().equalsIgnoreCase(name))
                .findFirst()
                .orElse(null);
    }

    @Test
    public void reads_table_columns_as_canonical_types() throws Exception {
        try (Connection c = conn()) {
            SchemaSnapshot live = new SchemaIntrospector().introspect(c, null);
            TableDescriptor program = table(live, "PROGRAM");
            assertNotNull(program);
            assertEquals(new SqlType.Int(64), col(program, "ID").sqlType());
            assertEquals(new SqlType.Text(120), col(program, "TITLE").sqlType());
        }
    }

    @Test
    public void missing_table_absent() throws Exception {
        try (Connection c = conn()) {
            assertNull(table(new SchemaIntrospector().introspect(c, null), "NOPE"));
        }
    }
}
