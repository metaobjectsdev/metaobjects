/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 */
package com.metaobjects.manager.db.validator;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.defs.TableDef;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.*;
import java.util.logging.Logger;

import static org.junit.Assert.*;

/**
 * Unit tests for MetaClassDBValidatorService exception propagation (Fix B).
 */
public class MetaClassDBValidatorServiceTest {

    /**
     * When autoCreate=false and the underlying driver reports that a table does not
     * exist, validateDefinition throws TableDoesNotExistException. Before the fix,
     * verifyMapping silently swallowed this; after the fix it must propagate as a
     * MetaDataException wrapping the original cause.
     */
    @Test
    public void verifyMappingPropagatesTableDoesNotExistException() throws Exception {
        MetaDataLoaderRegistry registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        MetaDataLoader loader = MetaDataLoader.fromResources(
            "test-validator", java.util.List.of("meta.fruit.json"));
        registry.registerLoader(loader);

        // A DerbyDriver subclass whose checkTable always returns false (table absent).
        DerbyDriver absentDriver = new DerbyDriver() {
            @Override
            public boolean checkTable(Connection c, TableDef table) throws SQLException {
                return false;
            }
        };

        String dbFile = "validator-test-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        // Create the DB so getConnection works; we don't need actual tables.
        DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true").close();

        try {
            DataSource ds = new DataSource() {
                @Override public Connection getConnection() throws SQLException {
                    return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
                }
                @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
                @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
                @Override public void setLogWriter(PrintWriter out) {}
                @Override public void setLoginTimeout(int s) {}
                @Override public int getLoginTimeout() { return 100; }
                @Override public Logger getParentLogger() { throw new UnsupportedOperationException(); }
                @Override public <T> T unwrap(Class<T> iface) { throw new UnsupportedOperationException(); }
                @Override public boolean isWrapperFor(Class<?> iface) { return false; }
            };

            ObjectManagerDB omdb = new ObjectManagerDB();
            omdb.setDatabaseDriver(absentDriver);
            omdb.setDataSource(ds);
            omdb.init();

            MetaClassDBValidatorService vs = new MetaClassDBValidatorService();
            vs.setObjectManager(omdb);
            vs.setAutoCreate(false);              // must NOT auto-create: triggers the throw path
            vs.setMetaDataLoaderRegistry(registry);

            try {
                vs.init();
                fail("init() must throw when autoCreate=false and the table is absent; "
                        + "verifyMapping must propagate TableDoesNotExistException, not swallow it");
            } catch (MetaDataException e) {
                // Expected: verifyMapping wraps and re-throws as MetaDataException.
                assertTrue("cause chain must contain TableDoesNotExistException",
                        isCausedBy(e, TableDoesNotExistException.class));
            }
        } finally {
            // Drop the in-memory DB.
            try { DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true"); }
            catch (SQLNonTransientConnectionException ignored) {}
            loader.destroy();
        }
    }

    /** Returns true if any cause in the chain is assignable to the given type. */
    private static boolean isCausedBy(Throwable t, Class<?> type) {
        while (t != null) {
            if (type.isInstance(t)) return true;
            t = t.getCause();
        }
        return false;
    }
}
