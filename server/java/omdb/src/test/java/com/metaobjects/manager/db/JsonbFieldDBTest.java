/*
 * Copyright 2012 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/*
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v10.html
 */
package com.metaobjects.manager.db;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.registry.ObjectClassBindingProvider;
import com.metaobjects.registry.ServiceRegistryFactory;

import org.junit.After;
import org.junit.AfterClass;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.*;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.logging.Logger;

import static org.junit.Assert.*;

/**
 * End-to-end test for typed jsonb value-object read/write via OMDB SQL driver.
 * Covers: typed round-trip, in-place-mutation-persists, and ValueObject fallback.
 */
public class JsonbFieldDBTest {

    // ---------------------------------------------------------------------------
    // Typed POJO for the jsonb value-object
    // ---------------------------------------------------------------------------

    /** Public mutable POJO matching jsonbtest::Prefs fields. */
    public static class Prefs {
        private String theme;
        private int fontSize;

        public Prefs() {}

        public Prefs(String theme, int fontSize) {
            this.theme = theme;
            this.fontSize = fontSize;
        }

        public String getTheme() { return theme; }
        public void setTheme(String theme) { this.theme = theme; }
        public int getFontSize() { return fontSize; }
        public void setFontSize(int fontSize) { this.fontSize = fontSize; }
    }

    // ---------------------------------------------------------------------------
    // Static test infrastructure
    // ---------------------------------------------------------------------------

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    private ObjectConnection oc;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());

        MetaDataLoader xl = MetaDataLoader.fromResources(
            "test-jsonb-db", java.util.List.of("meta.jsonb.json"));
        registry.registerLoader(xl);
        loader = xl;

        dbFile = "jsonb-testing-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return JsonbFieldDBTest.getConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() throws SQLException { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) throws SQLException {}
            @Override public void setLoginTimeout(int s) throws SQLException {}
            @Override public int getLoginTimeout() throws SQLException { return 100; }
            @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) throws SQLException { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) throws SQLException { return false; }
        };

        omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(ds);
        omdb.init();

        // Schema is external/explicit (ADR-0015): create JSONB_ITEM via literal DDL.
        // The `prefs` jsonb value-object column (@storage: jsonb) is written as a JSON
        // string (driver setString) and read back as a JSON string (driver getString),
        // so a portable text column holds it on Derby (Postgres uses native jsonb). This
        // exercises the runtime typed-jsonb bind/read path end-to-end against a live table.
        try (Connection c = getConnection();
             Statement s = c.createStatement()) {
            s.execute(
                "CREATE TABLE JSONB_ITEM (\n"
                    + "  id BIGINT GENERATED ALWAYS AS IDENTITY CONSTRAINT JSONB_ITEM_id_PK PRIMARY KEY,\n"
                    + "  prefs VARCHAR(4000)\n"
                    + ")");
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

    @Before
    public void startTx() throws Exception {
        oc = omdb.getConnection();
        // Install binding: jsonbtest::Prefs -> Prefs.class
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(new ObjectClassBindingProvider() {
            @Override
            public Map<String, Class<?>> bindings() {
                Map<String, Class<?>> m = new LinkedHashMap<>();
                m.put("jsonbtest::Prefs", Prefs.class);
                return m;
            }
        });
        ObjectClassRegistry.setGlobal(reg);
    }

    @After
    public void endTx() throws Exception {
        // Clean up rows so tests don't bleed into each other
        try (Connection c = getConnection();
             Statement s = c.createStatement()) {
            s.execute("DELETE FROM JSONB_ITEM");
        }
        omdb.releaseConnection(oc);
        ObjectClassRegistry.resetGlobal();
    }

    // ---------------------------------------------------------------------------
    // Test: typed round-trip + in-place mutation persists
    // ---------------------------------------------------------------------------

    @Test
    public void testTypedJsonbRoundTrip() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("jsonbtest::Item");
        assertNotNull("Item MetaObject not found", mo);

        // Create an Item with a typed Prefs value
        ValueObject item = (ValueObject) mo.newInstance();
        item.setObject("prefs", new Prefs("dark", 14));
        omdb.createObject(oc, item);

        // Reload and assert typed round-trip
        Collection<?> items = omdb.getObjects(oc, mo);
        assertFalse("Expected at least one Item", items.isEmpty());
        ValueObject loaded = (ValueObject) items.iterator().next();

        Object prefsObj = loaded.getObject("prefs");
        assertNotNull("prefs field should not be null", prefsObj);
        assertTrue("prefs should be a Prefs instance, got: " + prefsObj.getClass().getName(),
            prefsObj instanceof Prefs);
        Prefs loadedPrefs = (Prefs) prefsObj;
        assertEquals("dark", loadedPrefs.getTheme());
        assertEquals(14, loadedPrefs.getFontSize());

        // Read-modify-write: mutate in place, update, reload
        loadedPrefs.setTheme("light");
        loadedPrefs.setFontSize(16);
        // value is already set on loaded item since it's the same object reference;
        // also explicitly set to ensure the driver picks it up
        loaded.setObject("prefs", loadedPrefs);
        omdb.updateObject(oc, loaded);

        // Reload and assert mutation persisted
        items = omdb.getObjects(oc, mo);
        assertFalse("Expected at least one Item after update", items.isEmpty());
        ValueObject updated = (ValueObject) items.iterator().next();
        Object updatedPrefsObj = updated.getObject("prefs");
        assertTrue("prefs should still be a Prefs instance after update",
            updatedPrefsObj instanceof Prefs);
        Prefs updatedPrefs = (Prefs) updatedPrefsObj;
        assertEquals("light", updatedPrefs.getTheme());
        assertEquals(16, updatedPrefs.getFontSize());
    }

    // ---------------------------------------------------------------------------
    // Test: ValueObject fallback when no binding is registered
    // ---------------------------------------------------------------------------

    @Test
    public void testValueObjectFallbackWhenNoBinding() throws Exception {
        // Remove the Prefs binding so the driver falls back to Map/ValueObject
        ObjectClassRegistry.resetGlobal();

        MetaObject mo = registry.findMetaObjectByName("jsonbtest::Item");

        // Create an item first (with typed prefs, using the current empty registry)
        // We need a registry without Prefs for the whole test
        ValueObject item = (ValueObject) mo.newInstance();
        // Use a plain Map as the prefs value (will be serialized to JSON)
        Map<String, Object> rawPrefs = new LinkedHashMap<>();
        rawPrefs.put("theme", "solarized");
        rawPrefs.put("fontSize", 12);
        item.setObject("prefs", rawPrefs);
        omdb.createObject(oc, item);

        // Reload: with no binding, prefs should come back as a Map (not Prefs)
        Collection<?> items = omdb.getObjects(oc, mo);
        assertFalse("Expected at least one Item", items.isEmpty());
        ValueObject loaded = (ValueObject) items.iterator().next();

        Object prefsObj = loaded.getObject("prefs");
        assertNotNull("prefs field should not be null", prefsObj);
        assertFalse("prefs should NOT be a Prefs instance without binding",
            prefsObj instanceof Prefs);
        // The metadata-driven deserializer always returns a ValueObject when
        // no explicit class binding is registered (it uses the MetaObject's
        // declared @object class, which for jsonbtest::Prefs is ValueObject).
        assertTrue("prefs should be a ValueObject without binding, got: " + prefsObj.getClass().getName(),
            prefsObj instanceof ValueObject);
        ValueObject fallbackVo = (ValueObject) prefsObj;
        assertEquals("solarized", fallbackVo.getString("theme"));
        assertEquals(12, ((Number) fallbackVo.getObject("fontSize")).intValue());
    }
}
