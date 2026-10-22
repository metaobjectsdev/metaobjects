package com.metaobjects.manager.db;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;

import org.junit.After;
import org.junit.AfterClass;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.sql.*;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.logging.Logger;

import static org.junit.Assert.*;

/**
 * ADR-0019 Amendment 1, C1: a {@code field.map} whose values are a value object holds a decimal
 * per value, read exactly and written back unchanged. The map keys are arbitrary text and are
 * never matched with the value object's member names (a key named {@code amount} is a key).
 * Two shapes: a top-level jsonb map column and a map nested inside a value object.
 */
public class JsonbMapOfValueObjectDBTest {

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;
    private ObjectConnection oc;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources("test-jsonb-map-db", java.util.List.of("meta.jsonbmap.json"));
        registry.registerLoader(loader);

        dbFile = "jsonbmap-testing-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();
        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return JsonbMapOfValueObjectDBTest.getConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
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
        try (Connection c = getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE JSONMAP_DOC (\n"
                + "  id BIGINT GENERATED ALWAYS AS IDENTITY CONSTRAINT JSONMAP_DOC_id_PK PRIMARY KEY,\n"
                + "  tiers VARCHAR(4000),\n"
                + "  pricing VARCHAR(4000))");
        }
    }

    private static Connection getConnection() throws SQLException {
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

    @Before public void open() throws Exception { oc = omdb.getConnection(); }

    @After
    public void close() throws Exception {
        try (Connection c = getConnection(); Statement s = c.createStatement()) { s.execute("DELETE FROM JSONMAP_DOC"); }
        omdb.releaseConnection(oc);
    }

    private ValueObject tier(String amount) {
        ValueObject t = (ValueObject) registry.findMetaObjectByName("jsonmap::Tier").newInstance();
        t.setObject("amount", new BigDecimal(amount));
        return t;
    }

    private static BigDecimal amountOf(Object tier) {
        assertTrue("a map value must be a Tier value object, got " + (tier == null ? "null" : tier.getClass()),
            tier instanceof ValueObject);
        return (BigDecimal) ((ValueObject) tier).getObject("amount");
    }

    @SuppressWarnings("unchecked")
    @Test
    public void mapOfValueObjectsRoundTripsEachDecimalExactly() throws Exception {
        MetaObject doc = registry.findMetaObjectByName("jsonmap::Doc");
        ValueObject item = (ValueObject) doc.newInstance();
        Map<String, Object> tiers = new LinkedHashMap<>();
        tiers.put("amount", tier("1.5000"));        // a KEY named like the member: still a key
        tiers.put("gold", tier("2.5"));
        item.setObject("tiers", tiers);

        ValueObject pricing = (ValueObject) registry.findMetaObjectByName("jsonmap::Pricing").newInstance();
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("amount", tier("100"));
        nested.put("silver", tier("0.25"));
        pricing.setObject("tiers", nested);
        item.setObject("pricing", pricing);
        omdb.createObject(oc, item);

        Collection<?> rows = omdb.getObjects(oc, doc);
        assertEquals(1, rows.size());
        ValueObject loaded = (ValueObject) rows.iterator().next();

        Map<String, Object> top = (Map<String, Object>) loaded.getObject("tiers");
        assertEquals(java.util.List.of("amount", "gold"), new java.util.ArrayList<>(top.keySet()));
        assertEquals(0, new BigDecimal("1.5").compareTo(amountOf(top.get("amount"))));
        assertEquals(0, new BigDecimal("2.5").compareTo(amountOf(top.get("gold"))));

        ValueObject loadedPricing = (ValueObject) loaded.getObject("pricing");
        Map<String, Object> inner = (Map<String, Object>) loadedPricing.getObject("tiers");
        assertEquals(0, new BigDecimal("100").compareTo(amountOf(inner.get("amount"))));
        assertEquals(0, new BigDecimal("0.25").compareTo(amountOf(inner.get("silver"))));
    }

    @SuppressWarnings("unchecked")
    @Test
    public void storedJsonNumbersAreReadExactlyNotViaDouble() throws Exception {
        try (Connection c = getConnection(); Statement s = c.createStatement()) {
            s.execute("INSERT INTO JSONMAP_DOC (tiers, pricing) VALUES ("
                + "'{\"amount\":{\"amount\":12345678.1234},\"x\":{\"amount\":\"0.0001\"}}', "
                + "'{\"tiers\":{\"amount\":{\"amount\":0.1000}}}')");
        }
        MetaObject doc = registry.findMetaObjectByName("jsonmap::Doc");
        ValueObject loaded = (ValueObject) omdb.getObjects(oc, doc).iterator().next();
        Map<String, Object> top = (Map<String, Object>) loaded.getObject("tiers");
        assertEquals(new BigDecimal("12345678.1234"), amountOf(top.get("amount")));
        assertEquals(new BigDecimal("0.0001"), amountOf(top.get("x")));
        Map<String, Object> inner = (Map<String, Object>) ((ValueObject) loaded.getObject("pricing")).getObject("tiers");
        assertEquals(new BigDecimal("0.1000"), amountOf(inner.get("amount")));
    }
}
