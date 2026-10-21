package com.metaobjects.integration;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.SQLiteDriver;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * ADR-0019 Amendment 1, W4: a decimal read from SQLite is exact to 15 significant digits.
 * A NUMERIC column holds an INTEGER or a REAL; the OMDB read renders a REAL at 15 digits, so
 * {@code 0.1 + 0.2} reads {@code 0.3}, never {@code 0.30000000000000004}.
 */
final class SqliteDecimalReadTest {

    private SqliteDatabase sqlite;
    private MetaDataLoader loader;

    @BeforeEach
    void setUp() throws Exception {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of("dec::Entry", ValueObject.class));
        ObjectClassRegistry.setGlobal(reg);
        Path root = Files.createTempDirectory("dec-proj-");
        Files.createDirectories(root.resolve(".metaobjects"));
        Files.writeString(root.resolve(".metaobjects/config.json"),
            "{\"schema_version\":1,\"naming\":{\"columns\":\"literal\"}}");
        Path file = root.resolve("meta.entry.json");
        Files.writeString(file, """
            {"metadata.root":{"package":"dec","children":[
              {"object.entity":{"name":"Entry","children":[
                {"source.rdb":{"@table":"entries"}},
                {"field.long":{"name":"id"}},
                {"field.decimal":{"name":"amount","@precision":12,"@scale":2}},
                {"identity.primary":{"name":"id","@fields":"id","@generation":"increment"}}
              ]}}
            ]}}""");
        loader = MetaDataLoader.fromUris("dec", List.of(file.toUri()));
        sqlite = new SqliteDatabase();
        try (Connection c = open(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE entries (id INTEGER PRIMARY KEY, amount NUMERIC(12,2))");
            s.execute("INSERT INTO entries VALUES (1, 0.1 + 0.2)");
            s.execute("INSERT INTO entries VALUES (2, 12.50)");
            s.execute("INSERT INTO entries VALUES (3, 200)");
            s.execute("INSERT INTO entries VALUES (4, 1234567890123456789)");
            s.execute("INSERT INTO entries VALUES (5, NULL)");
        }
    }

    @AfterEach
    void tearDown() {
        sqlite.close();
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    void aStoredRealReadsToFifteenSignificantDigits() throws Exception {
        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new SQLiteDriver());
        omdb.setDataSource(dataSource());
        omdb.init();
        MetaObject entry = loader.getMetaObjectByName("dec::Entry");
        ObjectConnection oc = omdb.getConnection();
        List<BigDecimal> read = new ArrayList<>();
        try {
            for (Object o : omdb.getObjects(oc, entry, new QueryOptions())) {
                read.add((BigDecimal) ((ValueObject) o).getObject("amount"));
            }
        } finally {
            omdb.releaseConnection(oc);
        }
        assertEquals(5, read.size());
        assertEquals("0.3", read.get(0).toPlainString(), "0.1 + 0.2");
        assertEquals("12.5", read.get(1).toPlainString());
        assertEquals("200", read.get(2).toPlainString());
        assertEquals("1234567890123456789", read.get(3).toPlainString(), "an INTEGER is exact");
        assertEquals(null, read.get(4));
    }

    private Connection open() throws SQLException {
        return java.sql.DriverManager.getConnection(sqlite.jdbcUrl());
    }

    private DataSource dataSource() {
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
