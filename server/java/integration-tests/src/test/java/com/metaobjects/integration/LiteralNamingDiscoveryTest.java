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
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * B1 — a plain {@code MetaDataLoader.fromUris(...)} (no Spring, no Maven plugin) reads the
 * {@code naming} of the project's {@code .metaobjects/config.json} found by walking up from
 * the metadata file, so an OMDB read against SQLite columns named exactly like the fields
 * ({@code firstName}) works. With no config the same read looks for {@code first_name}.
 */
final class LiteralNamingDiscoveryTest {

    private SqliteDatabase sqlite;

    @BeforeEach
    void setUp() throws Exception {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of("lit::Person", ValueObject.class));
        ObjectClassRegistry.setGlobal(reg);
        sqlite = new SqliteDatabase();
        try (Connection c = open(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE people (id INTEGER PRIMARY KEY, \"firstName\" TEXT)");
            s.execute("INSERT INTO people VALUES (1, 'Ada')");
        }
    }

    @AfterEach
    void tearDown() {
        sqlite.close();
        ObjectClassRegistry.resetGlobal();
    }

    private static Path project(String config) throws Exception {
        Path root = Files.createTempDirectory("literal-proj-");
        if (config != null) {
            Files.createDirectories(root.resolve(".metaobjects"));
            Files.writeString(root.resolve(".metaobjects/config.json"), config);
        }
        Files.createDirectories(root.resolve("metaobjects"));
        Files.writeString(root.resolve("metaobjects/meta.person.json"), """
            {"metadata.root":{"package":"lit","children":[
              {"object.entity":{"name":"Person","children":[
                {"source.rdb":{"@table":"people"}},
                {"field.long":{"name":"id"}},
                {"field.string":{"name":"firstName","@maxLength":50}},
                {"identity.primary":{"name":"id","@fields":"id","@generation":"increment"}}
              ]}}
            ]}}""");
        return root;
    }

    private Collection<?> readAll(MetaDataLoader loader) throws Exception {
        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new SQLiteDriver());
        omdb.setDataSource(dataSource());
        omdb.init();
        MetaObject person = loader.getMetaObjectByName("lit::Person");
        ObjectConnection oc = omdb.getConnection();
        try {
            return omdb.getObjects(oc, person, new QueryOptions());
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    @Test
    void fromUrisReadsLiteralColumnsFromTheProjectConfigFoundByWalkingUp() throws Exception {
        Path root = project("{\"schema_version\":1,\"naming\":{\"columns\":\"literal\"}}");
        MetaDataLoader loader = MetaDataLoader.fromUris("literal",
            List.of(root.resolve("metaobjects/meta.person.json").toUri()));
        Collection<?> rows = readAll(loader);
        assertEquals(1, rows.size());
        assertEquals("Ada", ((ValueObject) rows.iterator().next()).getString("firstName"));
    }

    @Test
    void withoutAConfigTheRuntimeLooksForSnakeCaseColumns() throws Exception {
        Path root = project(null);
        MetaDataLoader loader = MetaDataLoader.fromUris("snake",
            List.of(root.resolve("metaobjects/meta.person.json").toUri()));
        assertThrows(Exception.class, () -> readAll(loader));
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

    private Connection open() throws SQLException {
        return java.sql.DriverManager.getConnection(sqlite.jdbcUrl());
    }
}
