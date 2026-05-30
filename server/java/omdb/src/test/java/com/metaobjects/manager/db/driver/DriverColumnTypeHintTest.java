package com.metaobjects.manager.db.driver;

import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.NameDef;
import com.metaobjects.manager.db.defs.TableDef;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.Types;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * R6 Plan 2a/2b — a {@link ColumnDef} carrying a physical column-type hint
 * ({@link ColumnDef#COLTYPE_UUID} / {@link ColumnDef#COLTYPE_JSONB} /
 * {@link ColumnDef#COLTYPE_TIMESTAMP_TZ}) renders the native column type instead
 * of the {@link java.sql.Types} default.
 *
 * <p>Postgres native emission ({@code UUID} / {@code JSONB} /
 * {@code TIMESTAMP WITH TIME ZONE} + the {@code gen_random_uuid()} PK default) is
 * asserted against the generated DDL string (no live Postgres needed for the
 * spelling). The Derby portable fallback ({@code CHAR(36)} / {@code CLOB} /
 * {@code TIMESTAMP}) is exercised end-to-end against embedded in-memory Derby so
 * the bootstrap path stays buildable on the non-Postgres dialect.</p>
 */
public class DriverColumnTypeHintTest {

    // -----------------------------------------------------------------------
    // Postgres — DDL string assertion (capture executed SQL, no live PG)
    // -----------------------------------------------------------------------

    private static TableDef assetTable() {
        TableDef t = new TableDef(new NameDef(null, "assets"));

        ColumnDef id = new ColumnDef("id", Types.VARCHAR);
        id.setDbColumnType(ColumnDef.COLTYPE_UUID);
        id.setPrimaryKey(true);
        id.setAutoType(ColumnDef.AUTO_UUID);
        t.addColumn(id);

        ColumnDef payload = new ColumnDef("payload", Types.VARCHAR);
        payload.setDbColumnType(ColumnDef.COLTYPE_JSONB);
        payload.setLength(65536);
        t.addColumn(payload);

        ColumnDef recordedAt = new ColumnDef("recordedAt", Types.TIMESTAMP);
        recordedAt.setDbColumnType(ColumnDef.COLTYPE_TIMESTAMP_TZ);
        t.addColumn(recordedAt);

        return t;
    }

    @Test
    public void postgresEmitsNativeColumnTypesAndUuidDefault() throws Exception {
        String sql = captureCreateTableSql(assetTable());

        assertTrue("uuid PK column: " + sql,
            sql.contains("\"id\" UUID DEFAULT gen_random_uuid()"));
        assertTrue("jsonb column: " + sql, sql.contains("\"payload\" JSONB"));
        assertTrue("timestamptz column: " + sql,
            sql.contains("\"recordedAt\" TIMESTAMP WITH TIME ZONE"));
    }

    @Test
    public void postgresUuidWithoutGenerationHasNoDefault() throws Exception {
        TableDef t = new TableDef(new NameDef(null, "assets"));
        ColumnDef ownerId = new ColumnDef("ownerId", Types.VARCHAR);
        ownerId.setDbColumnType(ColumnDef.COLTYPE_UUID); // non-key, no AUTO_UUID
        t.addColumn(ownerId);

        String sql = captureCreateTableSql(t);
        assertTrue("plain uuid column: " + sql, sql.contains("\"ownerId\" UUID"));
        assertTrue("no server default on a non-generated uuid: " + sql,
            !sql.contains("gen_random_uuid()"));
    }

    /**
     * Run PostgresDriver.createTable against a fake Connection that records the
     * SQL its Statement.execute receives. Returns the captured CREATE TABLE.
     */
    private static String captureCreateTableSql(TableDef table) throws Exception {
        java.util.List<String> executed = new java.util.ArrayList<>();
        Connection conn = (Connection) java.lang.reflect.Proxy.newProxyInstance(
            DriverColumnTypeHintTest.class.getClassLoader(),
            new Class<?>[]{Connection.class},
            (proxy, method, args) -> {
                if ("createStatement".equals(method.getName())) {
                    return java.lang.reflect.Proxy.newProxyInstance(
                        DriverColumnTypeHintTest.class.getClassLoader(),
                        new Class<?>[]{java.sql.Statement.class},
                        (sp, sm, sargs) -> {
                            if ("execute".equals(sm.getName()) && sargs != null && sargs.length > 0) {
                                executed.add(String.valueOf(sargs[0]));
                                return Boolean.FALSE;
                            }
                            if ("close".equals(sm.getName())) return null;
                            // Default returns for any other Statement method.
                            Class<?> rt = sm.getReturnType();
                            if (rt == boolean.class) return Boolean.FALSE;
                            if (rt == int.class) return 0;
                            return null;
                        });
                }
                if ("close".equals(method.getName())) return null;
                Class<?> rt = method.getReturnType();
                if (rt == boolean.class) return Boolean.FALSE;
                if (rt == int.class) return 0;
                return null;
            });

        new PostgresDriver().createTable(conn, table);
        assertEquals("expected exactly one CREATE TABLE execution", 1, executed.size());
        return executed.get(0);
    }

    // -----------------------------------------------------------------------
    // Derby — portable fallback, exercised end-to-end against in-memory Derby
    // -----------------------------------------------------------------------

    private static String dbFile;

    @BeforeClass
    public static void setUp() throws Exception {
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        dbFile = "coltype-hint-testing-" + System.currentTimeMillis();
    }

    @AfterClass
    public static void tearDown() {
        try {
            DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true");
        } catch (SQLNonTransientConnectionException ignored) {
        } catch (SQLException ignored) {
        }
    }

    private static Connection derbyConn() throws SQLException {
        return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
    }

    @Test
    public void derbyEmitsPortableFallbackTypes() throws Exception {
        DerbyDriver driver = new DerbyDriver();
        try (Connection c = derbyConn()) {
            driver.createTable(c, assetTable());

            Map<String, String> types = new HashMap<>();
            try (ResultSet rs = c.getMetaData().getColumns(null, null, "ASSETS", null)) {
                while (rs.next()) {
                    types.put(rs.getString("COLUMN_NAME").toUpperCase(),
                              rs.getString("TYPE_NAME").toUpperCase());
                }
            }
            // uuid → CHAR(36); jsonb → CLOB; timestamp_with_tz → TIMESTAMP.
            assertEquals("CHAR", types.get("ID"));
            assertEquals("CLOB", types.get("PAYLOAD"));
            assertEquals("TIMESTAMP", types.get("RECORDEDAT"));
        }
    }
}
