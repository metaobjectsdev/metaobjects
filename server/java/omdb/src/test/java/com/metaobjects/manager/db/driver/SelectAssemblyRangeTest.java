/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 *
 * Task 1.4 (remediation) — exercise the FULL getSelectStatementWhere assembly
 * path (not getRangeString in isolation) for OFFSET/FETCH dialects (MSSQL,
 * Oracle). An UNORDERED ranged query must emit the deterministic fallback
 * ORDER BY immediately followed by the OFFSET/FETCH range clause, in the correct
 * clause order. The assembled SQL is captured at prepareStatement() time via a
 * stub Connection, so no live database is required.
 */
package com.metaobjects.manager.db.driver;

import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.ObjectMapping;
import com.metaobjects.manager.db.ObjectMappingDB;
import com.metaobjects.manager.exp.Range;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.util.Collection;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

import static org.junit.Assert.*;

public class SelectAssemblyRangeTest {

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    /** Exposes the protected getReadMapping so the test can fetch the read mapping. */
    static class MappingExposingOMDB extends ObjectManagerDB {
        ObjectMapping readMappingFor(MetaObject mc) { return getReadMapping(mc); }
    }

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        // Reuse the codec fixture (codectest::Sample) — any concrete table-backed
        // entity works; we only need a valid read mapping to assemble a SELECT.
        loader = MetaDataLoader.fromResources("test-select-assembly", java.util.List.of("meta.codec.json"));
        registry.registerLoader(loader);

        dbFile = "omb-select-assembly-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        derbyConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return derbyConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int s) {}
            @Override public int getLoginTimeout() { return 100; }
            @Override public Logger getParentLogger() { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };

        MappingExposingOMDB m = new MappingExposingOMDB();
        // Derby driver just to bootstrap the schema / mapping. The actual assembly
        // under test uses MSSQL / Oracle drivers against a capturing stub Connection.
        m.setDatabaseDriver(new DerbyDriver());
        m.setDataSource(ds);
        m.init();
        omdb = m;

        // No schema needed: this test only assembles a SELECT statement string
        // (against a capturing stub Connection) from the read MAPPING, which is
        // derived from metadata — it never executes SQL against a live table. So
        // there is nothing to bootstrap now that runtime auto-create is removed.
    }

    private static Connection derbyConnection() throws SQLException {
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
     * A Connection whose only job is to capture the SQL passed to
     * prepareStatement(String) and return a no-op PreparedStatement proxy. No
     * statement is ever executed, so dialect-specific SQL never needs a real DB.
     */
    private static Connection capturingConnection(AtomicReference<String> sink) {
        InvocationHandler stmtHandler = (proxy, method, args) -> {
            switch (method.getName()) {
                case "close": return null;
                case "hashCode": return System.identityHashCode(proxy);
                case "equals": return proxy == args[0];
                case "toString": return "stub-PreparedStatement";
                default: return defaultReturn(method.getReturnType());
            }
        };
        PreparedStatement stubPs = (PreparedStatement) Proxy.newProxyInstance(
                SelectAssemblyRangeTest.class.getClassLoader(),
                new Class<?>[]{PreparedStatement.class}, stmtHandler);

        InvocationHandler connHandler = (proxy, method, args) -> {
            if ("prepareStatement".equals(method.getName()) && args != null && args.length >= 1) {
                sink.set((String) args[0]);
                return stubPs;
            }
            switch (method.getName()) {
                case "close": return null;
                case "hashCode": return System.identityHashCode(proxy);
                case "equals": return proxy == args[0];
                case "toString": return "stub-Connection";
                default: return defaultReturn(method.getReturnType());
            }
        };
        return (Connection) Proxy.newProxyInstance(
                SelectAssemblyRangeTest.class.getClassLoader(),
                new Class<?>[]{Connection.class}, connHandler);
    }

    private static Object defaultReturn(Class<?> rt) {
        if (rt == boolean.class) return false;
        if (rt == int.class) return 0;
        if (rt == long.class) return 0L;
        return null;
    }

    /** Drives the full getSelectStatementWhere assembly for an unordered ranged query. */
    private String assembleUnorderedRangedSelect(GenericSQLDriver driver) throws Exception {
        driver.setManager(omdb);
        MetaObject mc = registry.findMetaObjectByName("codectest::Sample");
        ObjectMappingDB mapping = (ObjectMappingDB) ((MappingExposingOMDB) omdb).readMappingFor(mc);
        Collection<MetaField> fields = mapping.getMetaFields();

        QueryOptions qo = new QueryOptions();   // NO sort order
        qo.setRange(11, 20);                     // offset 10, fetch 10

        AtomicReference<String> sql = new AtomicReference<>();
        driver.getSelectStatementWhere(capturingConnection(sql), mc, mapping, fields, qo);
        return sql.get();
    }

    @Test
    public void mssqlUnorderedRangeUsesFallbackOrderByThenOffsetFetch() throws Exception {
        String sql = assembleUnorderedRangedSelect(new MSSQLDriver());
        assertNotNull("SQL must have been assembled", sql);

        String fallback = "ORDER BY (SELECT NULL)";
        String range = "OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY";
        assertTrue("must contain the MSSQL fallback ORDER BY: " + sql, sql.contains(fallback));
        assertTrue("must contain the OFFSET/FETCH range: " + sql, sql.contains(range));
        // The range clause must immediately follow the fallback ORDER BY.
        assertTrue("fallback ORDER BY must be immediately followed by OFFSET/FETCH: " + sql,
                sql.contains(fallback + " " + range));
    }

    @Test
    public void oracleUnorderedRangeUsesFallbackOrderByThenOffsetFetch() throws Exception {
        String sql = assembleUnorderedRangedSelect(new OracleDriver());
        assertNotNull("SQL must have been assembled", sql);

        String fallback = "ORDER BY NULL";
        String range = "OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY";
        assertTrue("must contain the Oracle fallback ORDER BY: " + sql, sql.contains(fallback));
        assertTrue("must contain the OFFSET/FETCH range: " + sql, sql.contains(range));
        assertTrue("fallback ORDER BY must be immediately followed by OFFSET/FETCH: " + sql,
                sql.contains(fallback + " " + range));
    }
}
