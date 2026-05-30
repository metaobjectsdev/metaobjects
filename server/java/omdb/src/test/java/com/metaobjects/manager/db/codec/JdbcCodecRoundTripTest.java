/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
 * Task 1.5 — read/write parity through the JdbcCodecs registry. A value written
 * via the codec write path (setStatementValue) must read back equal via the
 * codec read path (parseField → JdbcFieldCodec.readInto). Exercises the real
 * JDBC IO against embedded Derby, the single source of truth for both sides.
 */
package com.metaobjects.manager.db.codec;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.validator.MetaClassDBValidatorService;
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
import java.util.Date;
import java.util.logging.Logger;

import static org.junit.Assert.*;

public class JdbcCodecRoundTripTest {

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources("test-codec", java.util.List.of("meta.codec.json"));
        registry.registerLoader(loader);

        dbFile = "omb-codec-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return JdbcCodecRoundTripTest.getConnection(); }
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

    /**
     * Write a row carrying a value for each codec-handled primitive type, then
     * read it back through the codec path and assert read == written.
     */
    @Test
    public void primitivesRoundTripThroughCodecs() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("codectest::Sample");
        assertNotNull(mo);

        ObjectConnection oc = omdb.getConnection();
        try {
            ValueObject vo = (ValueObject) mo.newInstance();
            vo.setInt("count", 42);
            vo.setLong("bignum", 9_000_000_000L);   // > Integer.MAX_VALUE, proves LongCodec
            vo.setBoolean("active", true);
            vo.setDouble("ratio", 3.5d);
            vo.setString("label", "hello-codec");
            Date created = new Date(1_700_000_000_000L);
            vo.setDate("createdAt", created);

            omdb.createObject(oc, vo);

            Collection<?> rows = omdb.getObjects(oc, mo,
                    new QueryOptions(new Expression("label", "hello-codec", Expression.EQUAL)));
            assertEquals("exactly one row written", 1, rows.size());

            ValueObject read = (ValueObject) rows.iterator().next();
            assertEquals("IntegerCodec round-trip", Integer.valueOf(42), read.getInt("count"));
            assertEquals("LongCodec round-trip", Long.valueOf(9_000_000_000L), read.getLong("bignum"));
            assertEquals("BooleanCodec round-trip", Boolean.TRUE, read.getBoolean("active"));
            assertEquals("DoubleCodec round-trip", Double.valueOf(3.5d), read.getDouble("ratio"));
            assertEquals("StringCodec round-trip", "hello-codec", read.getString("label"));
            // DateCodec stores as a timestamp; compare epoch millis.
            assertNotNull("DateCodec round-trip non-null", read.getDate("createdAt"));
            assertEquals("DateCodec round-trip", created.getTime(), read.getDate("createdAt").getTime());
        } finally {
            omdb.releaseConnection(oc);
        }
    }
}
