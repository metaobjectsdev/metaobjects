package com.metaobjects.integration;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.SQLiteDriver;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.manager.exp.Range;
import com.metaobjects.manager.exp.SortOrder;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.loader.uri.URIHelper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The OMDB runtime against a real SQLite database: insert, read, query, page, update, delete.
 * SQLite is embedded, so there is no container and the test needs no docker.
 *
 * <p>The table is written here the way {@code meta migrate --dialect sqlite} writes one (a
 * {@code TEXT} column for a timestamp and a uuid, {@code INTEGER} for a boolean). What it pins:
 * <ul>
 *   <li>{@code INTEGER PRIMARY KEY AUTOINCREMENT} is read back with {@code last_insert_rowid()}.</li>
 *   <li>A column named after a reserved word ({@code rank}) works in INSERT, SELECT, WHERE,
 *       ORDER BY and UPDATE (identifiers are double-quoted).</li>
 *   <li>{@code LIMIT .. OFFSET ..} paging.</li>
 *   <li>A timestamp is ISO-8601 UTC text and round-trips to the same instant whatever the JVM
 *       zone is; a uuid is lower-case text; a decimal keeps its value.</li>
 * </ul>
 */
final class SqliteObjectManagerTest {

    private static final long CREATED_MS = 1_780_000_000_000L;

    private static SqliteDatabase sqlite;
    private static MetaDataLoader loader;
    private static java.util.TimeZone previousZone;

    @BeforeAll
    static void beforeAll() throws Exception {
        // A NON-UTC JVM zone on purpose: the DATETIME round-trip must not depend on it.
        previousZone = java.util.TimeZone.getDefault();
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/New_York"));
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of("shop::Product", ValueObject.class));
        ObjectClassRegistry.setGlobal(reg);

        loader = MetaDataLoader.fromUris("sqlite-shop",
            List.of(URIHelper.toURI("model:resource:meta.mysql-shop.json")));
        // This fixture's hand-rolled DDL below declares every column literally
        // (createdAt) — it needs the `literal` naming.columns rule (ADR-0058's default
        // is now snake_case in every port).
        loader.getRoot().setPhysicalNaming(
                com.metaobjects.database.PhysicalNaming.of("literal", "snake_case"));
        sqlite = new SqliteDatabase();
        try (Connection c = open(); Statement s = c.createStatement()) {
            s.execute("""
                CREATE TABLE products (
                  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                  title VARCHAR(200) NOT NULL,
                  "rank" INTEGER NOT NULL,
                  active INTEGER NOT NULL,
                  price NUMERIC(10,2),
                  createdAt TEXT NOT NULL,
                  localAt TEXT,
                  externalId TEXT
                )""");
        }
    }

    @AfterAll
    static void afterAll() {
        if (sqlite != null) sqlite.close();
        if (previousZone != null) java.util.TimeZone.setDefault(previousZone);
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    void crudRoundTripsThroughTheSqliteDriver() throws Exception {
        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new SQLiteDriver());
        omdb.setDataSource(dataSource());
        omdb.init();

        MetaObject product = loader.getMetaObjectByName("shop::Product");
        ObjectConnection oc = omdb.getConnection();
        try {
            // --- create: the auto-increment key is read back onto the object -------------
            List<ValueObject> created = new ArrayList<>();
            for (int i = 1; i <= 3; i++) {
                ValueObject vo = (ValueObject) product.newInstance();
                vo.setString("title", "Product " + i);
                vo.setInt("rank", 10 * i);
                vo.setBoolean("active", i != 2);
                vo.setObject("price", new BigDecimal(i + ".50"));
                vo.setDate("createdAt", new Date(CREATED_MS + i));
                vo.setDate("localAt", new Date(CREATED_MS + i));
                vo.setString("externalId", "AAAAAAAA-AAAA-4AAA-8AAA-00000000000" + i);
                omdb.createObject(oc, vo);
                created.add(vo);
            }
            assertEquals(1L, created.get(0).getLong("id"), "first insert gets id 1 from last_insert_rowid()");
            assertEquals(3L, created.get(2).getLong("id"), "third insert gets id 3");

            // --- read by key, including the reserved-word column --------------------------
            ValueObject two = only(omdb.getObjects(oc, product,
                new QueryOptions(new Expression("id", 2L, Expression.EQUAL))));
            assertEquals("Product 2", two.getString("title"));
            assertEquals(20, two.getInt("rank"));
            assertEquals(Boolean.FALSE, two.getBoolean("active"));
            assertEquals(0, new BigDecimal("2.50").compareTo((BigDecimal) two.getObject("price")));
            assertEquals(CREATED_MS + 2, two.getDate("createdAt").getTime(),
                "a timestamp round-trips to the same instant");
            assertEquals(CREATED_MS + 2, two.getDate("localAt").getTime(),
                "an @localTime timestamp round-trips to the same UTC wall clock");
            assertEquals("aaaaaaaa-aaaa-4aaa-8aaa-000000000002", two.getString("externalId"),
                "uuid is stored as text and read back lowercase-canonical");
            try (Connection c = open(); Statement s = c.createStatement();
                 java.sql.ResultSet rs = s.executeQuery(
                     "SELECT createdAt FROM products WHERE id = 2")) {
                assertTrue(rs.next());
                assertEquals(java.time.Instant.ofEpochMilli(CREATED_MS + 2).toString(),
                    rs.getString(1), "the column holds the ISO-8601 UTC text of the instant");
            }

            // --- WHERE and ORDER BY on the reserved-word column, then LIMIT paging --------
            QueryOptions page = new QueryOptions(
                new Expression("rank", 10, Expression.GREATER),
                new SortOrder("rank", SortOrder.DESC),
                new Range(2, 2));
            ValueObject second = only(omdb.getObjects(oc, product, page));
            assertEquals("Product 2", second.getString("title"),
                "rank > 10 ordered DESC is [30, 20]; the second row of the page is rank 20");

            // --- update ---------------------------------------------------------------------
            two.setString("title", "Renamed");
            two.setInt("rank", 99);
            omdb.updateObject(oc, two);
            ValueObject reread = only(omdb.getObjects(oc, product,
                new QueryOptions(new Expression("id", 2L, Expression.EQUAL))));
            assertEquals("Renamed", reread.getString("title"));
            assertEquals(99, reread.getInt("rank"));

            // --- delete ---------------------------------------------------------------------
            omdb.deleteObject(oc, reread);
            assertEquals(2, omdb.getObjects(oc, product, new QueryOptions()).size());
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    private static ValueObject only(Collection<?> rows) {
        assertEquals(1, rows.size(), "expected exactly one row, got " + rows.size());
        Object first = rows.iterator().next();
        assertTrue(first instanceof ValueObject, "row should be a ValueObject");
        return (ValueObject) first;
    }

    private static Connection open() throws SQLException {
        return java.sql.DriverManager.getConnection(sqlite.jdbcUrl());
    }

    private static DataSource dataSource() {
        return new DataSource() {
            @Override public Connection getConnection() throws SQLException { return open(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return open(); }
            @Override public PrintWriter getLogWriter() { return null; }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int seconds) {}
            @Override public int getLoginTimeout() { return 0; }
            @Override public Logger getParentLogger() { return Logger.getGlobal(); }
            @Override public <T> T unwrap(Class<T> iface) throws SQLException { throw new SQLException("not a wrapper"); }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };
    }
}
