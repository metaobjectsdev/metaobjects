/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * Task 1.7 — app-side UUID primary keys. An identity.primary with
 * @generation: "uuid" must have OMDB mint a java.util.UUID string before INSERT
 * (DB-portable; no DB-side default / identity), not be treated as an integer
 * auto-increment.
 */
package com.metaobjects.manager.db;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.exp.Expression;
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
import java.util.Collection;
import java.util.UUID;
import java.util.logging.Logger;

import static org.junit.Assert.*;

public class UuidPrimaryKeyTest {

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources("test-uuid", java.util.List.of("meta.uuid.json"));
        registry.registerLoader(loader);

        dbFile = "omb-uuid-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return UuidPrimaryKeyTest.getConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int s) {}
            @Override public int getLoginTimeout() { return 100; }
            @Override public Logger getParentLogger() { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };

        omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(ds);
        omdb.init();

        // Schema is external/explicit (ADR-0015): create UUID_WIDGET via literal DDL.
        // The `id` PK is an app-side UUID (identity @generation:"uuid" → AUTO_UUID):
        // OMDB mints the java.util.UUID string before INSERT, so the column is a plain
        // portable CHAR(36) with NO DB-side identity/default (this is the DB-portable
        // app-side-mint path; native uuid columns + gen_random_uuid() are a Postgres
        // concern exercised by the Testcontainers integration suite).
        try (Connection c = getConnection();
             Statement s = c.createStatement()) {
            s.execute(
                "CREATE TABLE UUID_WIDGET (\n"
                    + "  id CHAR(36) CONSTRAINT UUID_WIDGET_id_PK PRIMARY KEY,\n"
                    + "  name VARCHAR(100)\n"
                    + ")");
        }
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

    @Test
    public void uuidPrimaryKeyIsMintedAppSideBeforeInsert() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("uuidtest::Widget");
        assertNotNull(mo);

        ObjectConnection oc = omdb.getConnection();
        try {
            ValueObject vo = (ValueObject) mo.newInstance();
            vo.setString("name", "gizmo");
            assertNull("id is unset before create", vo.getString("id"));

            omdb.createObject(oc, vo);

            // OMDB (not the DB) must have assigned a valid UUID string.
            String mintedId = vo.getString("id");
            assertNotNull("OMDB must mint the UUID before insert", mintedId);
            // Throws IllegalArgumentException if it is not a well-formed UUID.
            UUID parsed = UUID.fromString(mintedId);
            assertEquals("round-trips as a canonical UUID", mintedId, parsed.toString());

            // Reload by the minted id and confirm persistence.
            Collection<?> rows = omdb.getObjects(oc, mo,
                    new QueryOptions(new Expression("id", mintedId, Expression.EQUAL)));
            assertEquals("exactly one row persisted under the minted UUID", 1, rows.size());
            ValueObject read = (ValueObject) rows.iterator().next();
            assertEquals(mintedId, read.getString("id"));
            assertEquals("gizmo", read.getString("name"));
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    /**
     * Task 1.7 (remediation) — the mint guard ({@code if (f.getString(o) == null)})
     * must NOT clobber a caller-supplied UUID. When the PK is pre-set before
     * create, the persisted + reloaded id must equal that exact value.
     */
    @Test
    public void callerSuppliedUuidIsNotClobbered() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("uuidtest::Widget");
        assertNotNull(mo);

        String presetId = UUID.randomUUID().toString();

        ObjectConnection oc = omdb.getConnection();
        try {
            ValueObject vo = (ValueObject) mo.newInstance();
            vo.setString("id", presetId);            // caller supplies the UUID
            vo.setString("name", "preset");

            omdb.createObject(oc, vo);

            // The mint guard must have left the caller's value intact.
            assertEquals("OMDB must not overwrite a caller-supplied UUID PK",
                    presetId, vo.getString("id"));

            // Reload by the preset id and confirm it persisted under that exact value.
            Collection<?> rows = omdb.getObjects(oc, mo,
                    new QueryOptions(new Expression("id", presetId, Expression.EQUAL)));
            assertEquals("exactly one row persisted under the caller-supplied UUID", 1, rows.size());
            ValueObject read = (ValueObject) rows.iterator().next();
            assertEquals("reloaded id equals the caller-supplied UUID", presetId, read.getString("id"));
            assertEquals("preset", read.getString("name"));
        } finally {
            omdb.releaseConnection(oc);
        }
    }
}
