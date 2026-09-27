package com.metaobjects.integration;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.MySQLDriver;
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
 * The OMDB runtime against a real MySQL server: insert, read, query, page, update, delete.
 *
 * <p>MySQL is a runtime target for the Java port only. MetaObjects does not own a MySQL schema
 * ({@code meta migrate} supports Postgres, SQLite and D1), so this test writes its own DDL, the
 * same way an adopter on MySQL would.
 *
 * <p>What it pins:
 * <ul>
 *   <li>{@code @generation: increment} reads the new key back with {@code LAST_INSERT_ID()}.
 *       Before the fix, every such insert failed with "This should not get called".</li>
 *   <li>Identifiers are backtick-quoted, so a column named after a MySQL 8 reserved word
 *       ({@code rank}) works in INSERT, SELECT, WHERE, ORDER BY and UPDATE.</li>
 *   <li>{@code LIMIT offset, count} paging.</li>
 * </ul>
 *
 * <p>Not part of the default Maven reactor build. Run it with
 * {@code mvn -f server/java/integration-tests/pom.xml test -Dtest=MySqlObjectManagerTest}.
 */
final class MySqlObjectManagerTest {

    private static final long CREATED_MS = 1_780_000_000_000L;

    private static MySqlContainer mysql;
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

        loader = MetaDataLoader.fromUris("mysql-shop",
            List.of(URIHelper.toURI("model:resource:meta.mysql-shop.json")));
        mysql = new MySqlContainer();
        try (Connection c = mysql.open(); Statement s = c.createStatement()) {
            s.execute("DROP TABLE IF EXISTS products");
            s.execute("""
                CREATE TABLE products (
                  id BIGINT AUTO_INCREMENT PRIMARY KEY,
                  title VARCHAR(200) NOT NULL,
                  `rank` INT NOT NULL,
                  active BOOLEAN NOT NULL,
                  price DECIMAL(10,2),
                  createdAt DATETIME(3) NOT NULL,
                  localAt DATETIME(3),
                  externalId CHAR(36)
                )""");
        }
    }

    @AfterAll
    static void afterAll() {
        if (mysql != null) mysql.close();
        if (previousZone != null) java.util.TimeZone.setDefault(previousZone);
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    void crudRoundTripsThroughTheMySqlDriver() throws Exception {
        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new MySQLDriver());
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
            assertEquals(1L, created.get(0).getLong("id"), "first insert gets id 1 from LAST_INSERT_ID()");
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
            try (Connection c = mysql.open(); Statement s = c.createStatement();
                 java.sql.ResultSet rs = s.executeQuery(
                     "SELECT DATE_FORMAT(createdAt, '%Y-%m-%dT%H:%i:%s.%f') FROM products WHERE id = 2")) {
                assertTrue(rs.next());
                assertEquals(java.time.Instant.ofEpochMilli(CREATED_MS + 2).toString().replace("Z", "000"),
                    rs.getString(1), "the DATETIME column holds the UTC wall clock of the instant");
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

    private static DataSource dataSource() {
        return new DataSource() {
            @Override public Connection getConnection() throws SQLException { return mysql.open(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return mysql.open(); }
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
