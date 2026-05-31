/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * FR-003 Plan 4 (Debt 2) — atomic mapping cache off the shared MetaObject.
 * Verifies (a) memoization, (b) state does NOT live on the metamodel, and
 * (c) N concurrent callers all observe one mapping instance.
 *
 * Self-contained setup (mirrors JsonbFieldDBTest) so the shared static state
 * in AbstractOMDBTest is not destroyed between test classes.
 */
package com.metaobjects.manager.db;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.object.MetaObject;
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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public class MappingCacheTest {

    private static final String BASKET_FQN = "container::Basket";

    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;
    private static ObjectManagerDB omdb;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());

        MetaDataLoader xl = MetaDataLoader.fromResources(
            "test-mapping-cache", java.util.List.of("meta.fruit.json"));
        registry.registerLoader(xl);
        loader = xl;

        dbFile = "mapping-cache-" + System.currentTimeMillis();
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

        // No schema needed: this test exercises only the mapping-cache (read/
        // create/update/delete MAPPINGS are derived from metadata, not the DB) —
        // it never executes SQL against a live table. Nothing to bootstrap now
        // that runtime auto-create is removed.
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
    public void readMappingIsMemoized() {
        MetaObject mc = registry.findMetaObjectByName(BASKET_FQN);
        assertNotNull("Basket MetaObject must be loaded", mc);

        ObjectMapping a = omdb.getReadMapping(mc);
        ObjectMapping b = omdb.getReadMapping(mc);
        assertNotNull("read mapping must resolve", a);
        assertSame("read mapping must be memoized (same instance)", a, b);
    }

    @Test
    public void mappingStateIsNotStoredOnMetaObject() {
        MetaObject mc = registry.findMetaObjectByName(BASKET_FQN);
        assertNotNull(mc);

        omdb.getReadMapping(mc);
        omdb.getCreateMapping(mc);
        omdb.getUpdateMapping(mc);
        omdb.getDeleteMapping(mc);

        assertNull("read mapping must not be cached on the shared MetaObject",
            mc.getCacheValue("dbReadMap"));
        assertNull("create mapping must not be cached on the shared MetaObject",
            mc.getCacheValue("dbCreateMap"));
        assertNull("update mapping must not be cached on the shared MetaObject",
            mc.getCacheValue("dbUpdateMap"));
        assertNull("delete mapping must not be cached on the shared MetaObject",
            mc.getCacheValue("dbDeleteMap"));
    }

    @Test
    public void concurrentCallersGetOneInstance() throws Exception {
        MetaObject mc = registry.findMetaObjectByName(BASKET_FQN);
        assertNotNull(mc);

        int n = 16;
        ExecutorService pool = Executors.newFixedThreadPool(n);
        ConcurrentHashMap<Integer, ObjectMapping> results = new ConcurrentHashMap<>();
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(n);
        try {
            for (int i = 0; i < n; i++) {
                final int id = i;
                pool.submit(() -> {
                    try {
                        start.await();
                        results.put(id, omdb.getReadMapping(mc));
                    } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                    } finally {
                        done.countDown();
                    }
                });
            }
            start.countDown();
            assertTrue("all threads must finish within 30s", done.await(30, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }
        long distinct = results.values().stream().distinct().count();
        assertEquals("all threads must observe one memoized mapping instance", 1L, distinct);
    }
}
