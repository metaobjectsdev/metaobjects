/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * Task 1.6 — bulk-create fallback must be atomic (all-or-nothing) and pass the
 * live ObjectConnection (not null) to the pre/post-persistence hooks.
 */
package com.metaobjects.manager.db;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.validator.MetaClassDBValidatorService;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.*;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;

import static org.junit.Assert.*;

public class BulkCreateFallbackTest {

    /** Captures the ObjectConnection handed to the persistence hooks. */
    static class CapturingOMDB extends ObjectManagerDB {
        final List<ObjectConnection> preConns = new ArrayList<>();
        final List<ObjectConnection> postConns = new ArrayList<>();
        @Override
        public void prePersistence(ObjectConnection c, MetaObject mc, Object obj, int action) {
            preConns.add(c);
            super.prePersistence(c, mc, obj, action);
        }
        @Override
        public void postPersistence(ObjectConnection c, MetaObject mc, Object obj, int action) {
            postConns.add(c);
            super.postPersistence(c, mc, obj, action);
        }
    }

    private static CapturingOMDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources("test-bulk", java.util.List.of("meta.codec.json"));
        registry.registerLoader(loader);

        dbFile = "omb-bulk-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return BulkCreateFallbackTest.getConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int s) {}
            @Override public int getLoginTimeout() { return 100; }
            @Override public Logger getParentLogger() { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };

        omdb = new CapturingOMDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(ds);
        omdb.init();

        MetaClassDBValidatorService vs = new MetaClassDBValidatorService();
        vs.setObjectManager(omdb);
        vs.setAutoCreate(true);
        vs.setMetaDataLoaderRegistry(registry);
        vs.init();
    }

    private static Connection getConnection() throws SQLException {
        return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
    }

    @AfterClass
    public static void teardown() throws Exception {
        if (dbFile != null) {
            try { DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true"); }
            catch (SQLNonTransientConnectionException ignored) {}
        }
        if (loader != null) loader.destroy();
    }

    private ValueObject sample(MetaObject mo, String label) {
        ValueObject vo = (ValueObject) mo.newInstance();
        vo.setInt("count", 1);
        vo.setLong("bignum", 1L);
        vo.setBoolean("active", true);
        vo.setDouble("ratio", 1.0d);
        vo.setString("label", label);
        vo.setDate("createdAt", new java.util.Date(1_700_000_000_000L));
        return vo;
    }

    private long countRows(MetaObject mo, ObjectConnection oc) throws Exception {
        return omdb.getObjects(oc, mo).size();
    }

    @Test
    public void happyPathBulkCreatePassesLiveConnectionToHooks() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("codectest::Sample");
        omdb.preConns.clear();
        omdb.postConns.clear();

        ObjectConnection oc = omdb.getConnection();
        try {
            Collection<Object> batch = new ArrayList<>();
            for (int i = 0; i < 5; i++) batch.add(sample(mo, "happy-" + i));
            omdb.createObjectsBulk(oc, mo, batch);
            oc.commit();
        } finally {
            omdb.releaseConnection(oc);
        }

        ObjectConnection verify = omdb.getConnection();
        try {
            long n = omdb.getObjects(verify, mo,
                    new com.metaobjects.manager.QueryOptions(
                            new com.metaobjects.manager.exp.Expression("label", "happy-", com.metaobjects.manager.exp.Expression.START_WITH))).size();
            assertEquals("all 5 rows persisted", 5, n);
        } finally {
            omdb.releaseConnection(verify);
        }

        assertEquals("prePersistence fired once per object", 5, omdb.preConns.size());
        assertEquals("postPersistence fired once per object", 5, omdb.postConns.size());
        omdb.preConns.forEach(c -> assertNotNull("prePersistence received a live (non-null) ObjectConnection", c));
        omdb.postConns.forEach(c -> assertNotNull("postPersistence received a live (non-null) ObjectConnection", c));
    }

    @Test
    public void midBatchFailureRollsBackEntireBatch() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("codectest::Sample");

        // label is VARCHAR(100); a 200-char label overflows the column and forces
        // an insert failure partway through the batch.
        String tooLong = "x".repeat(200);

        ObjectConnection oc = omdb.getConnection();
        long before;
        try {
            before = countRows(mo, oc);
            Collection<Object> batch = new ArrayList<>();
            batch.add(sample(mo, "atomic-ok-1"));
            batch.add(sample(mo, "atomic-ok-2"));
            batch.add(sample(mo, tooLong));          // <-- fails here
            batch.add(sample(mo, "atomic-ok-3"));

            try {
                omdb.createObjectsBulk(oc, mo, batch);
                oc.commit();
                fail("expected bulk create to fail on the oversized row");
            } catch (Exception expected) {
                // good — now the whole batch must have been rolled back
            }
        } finally {
            omdb.releaseConnection(oc);
        }

        ObjectConnection verify = omdb.getConnection();
        try {
            long after = countRows(mo, verify);
            assertEquals("a mid-batch failure must roll back the entire batch (all-or-nothing)",
                    before, after);
            // none of the valid rows from the failed batch should be present
            long oks = omdb.getObjects(verify, mo,
                    new com.metaobjects.manager.QueryOptions(
                            new com.metaobjects.manager.exp.Expression("label", "atomic-ok-", com.metaobjects.manager.exp.Expression.START_WITH))).size();
            assertEquals("no partial rows from the failed batch", 0, oks);
        } finally {
            omdb.releaseConnection(verify);
        }
    }
}
