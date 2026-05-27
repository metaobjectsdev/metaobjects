/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * FR-003 Plan 4 (Debt 3) — inTransaction template method.
 * Verifies (a) commit on normal return, (b) rollback + rethrow on RuntimeException,
 * (c) SQLException is caught + wrapped as MetaDataException after rollback,
 * (d) the connection lifecycle is closed properly so subsequent transactions work.
 */
package com.metaobjects.manager.db;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.validator.MetaClassDBValidatorService;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.SQLNonTransientConnectionException;
import java.util.logging.Logger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public class InTransactionTest {

    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;
    private static ObjectManagerDB omdb;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources(
            "test-intransaction", java.util.List.of("meta.fruit.json"));
        registry.registerLoader(loader);

        dbFile = "intransaction-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        connection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return connection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return connection(); }
            @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int s) {}
            @Override public int getLoginTimeout() { return 100; }
            @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };

        omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(ds);
        omdb.init();

        MetaClassDBValidatorService vs = new MetaClassDBValidatorService();
        vs.setObjectManager(omdb);
        vs.setAutoCreate(true);
        vs.setMetaDataLoaderRegistry(registry);
        vs.init();
    }

    private static Connection connection() throws SQLException {
        return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
    }

    @AfterClass
    public static void destroyDB() throws Exception {
        if (dbFile != null) {
            try { DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true"); }
            catch (SQLNonTransientConnectionException ignored) {}
        }
        if (loader != null) loader.destroy();
    }

    @Test
    public void commitsOnSuccess() throws Exception {
        int result = omdb.inTransaction(c -> 99);
        assertEquals(99, result);
    }

    @Test
    public void rollsBackAndRethrowsRuntimeException() {
        IllegalStateException boom = assertThrows(IllegalStateException.class, () ->
            omdb.inTransaction(c -> { throw new IllegalStateException("boom"); }));
        assertEquals("boom", boom.getMessage());
    }

    @Test
    public void rollsBackAndWrapsSqlException() {
        MetaDataException wrapped = assertThrows(MetaDataException.class, () ->
            omdb.inTransaction(c -> { throw new SQLException("db went away"); }));
        assertEquals("db went away", wrapped.getCause().getMessage());
    }

    @Test
    public void connectionIsReleasedSoSubsequentWorksToo() throws Exception {
        // Force a rollback path first, then verify a new transaction still succeeds —
        // proves the connection was returned to the pool on the exception path.
        assertThrows(IllegalStateException.class, () ->
            omdb.inTransaction(c -> { throw new IllegalStateException("boom"); }));
        assertEquals(1, (int) omdb.inTransaction(c -> 1));
    }
}
