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
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
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

    /** Public mutable POJO matching jsonbtest::Label fields (the array-of-VO element). */
    public static class Label {
        private String key;
        private int weight;

        public Label() {}

        public Label(String key, int weight) {
            this.key = key;
            this.weight = weight;
        }

        public String getKey() { return key; }
        public void setKey(String key) { this.key = key; }
        public int getWeight() { return weight; }
        public void setWeight(int weight) { this.weight = weight; }
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
                    + "  prefs VARCHAR(4000),\n"
                    + "  labels VARCHAR(4000)\n"
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
                m.put("jsonbtest::Label", Label.class);
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

    // ---------------------------------------------------------------------------
    // Test: typed array-of-VO (field.object @storage:jsonb isArray:true) round-trip
    //
    // Proves the array-of-VO write+read codec: a List<Label> is serialized to a JSON
    // array on write and reconstructed into a typed List<Label> on read (element order
    // preserved). This is the SP-H labels-array wire contract exercised by the
    // persistence-conformance roundtrip corpus, gated here against a live SQL table.
    // ---------------------------------------------------------------------------

    @Test
    public void testTypedJsonbArrayRoundTrip() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("jsonbtest::Item");
        assertNotNull("Item MetaObject not found", mo);

        // Create an Item with a typed List<Label> value (2 elements, order significant).
        ValueObject item = (ValueObject) mo.newInstance();
        List<Label> labels = new ArrayList<>();
        labels.add(new Label("alpha", 10));
        labels.add(new Label("beta", 20));
        item.setObjectArray("labels", labels);
        omdb.createObject(oc, item);

        // Reload and assert the array round-tripped as a typed List<Label>, order preserved.
        Collection<?> items = omdb.getObjects(oc, mo);
        assertFalse("Expected at least one Item", items.isEmpty());
        ValueObject loaded = (ValueObject) items.iterator().next();

        Object labelsObj = loaded.getObject("labels");
        assertNotNull("labels field should not be null", labelsObj);
        assertTrue("labels should be a List, got: " + labelsObj.getClass().getName(),
            labelsObj instanceof List);
        List<?> loadedLabels = (List<?>) labelsObj;
        assertEquals("labels should have 2 elements", 2, loadedLabels.size());

        assertTrue("element 0 should be a Label, got: " + loadedLabels.get(0).getClass().getName(),
            loadedLabels.get(0) instanceof Label);
        Label first = (Label) loadedLabels.get(0);
        assertEquals("alpha", first.getKey());
        assertEquals(10, first.getWeight());

        Label second = (Label) loadedLabels.get(1);
        assertEquals("beta", second.getKey());
        assertEquals(20, second.getWeight());
    }

    // ---------------------------------------------------------------------------
    // Test: empty-array (`[]` distinct from null) + single-element round-trips.
    // ---------------------------------------------------------------------------

    @Test
    public void testJsonbEmptyAndSingleArrayRoundTrip() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("jsonbtest::Item");

        // (a) empty array must round-trip as an empty List (distinct from null).
        ValueObject empty = (ValueObject) mo.newInstance();
        empty.setObjectArray("labels", new ArrayList<Label>());
        omdb.createObject(oc, empty);

        Collection<?> items = omdb.getObjects(oc, mo);
        assertFalse("Expected the empty-array row", items.isEmpty());
        ValueObject loadedEmpty = (ValueObject) items.iterator().next();
        Object emptyObj = loadedEmpty.getObject("labels");
        assertNotNull("empty labels array must round-trip as [] not null", emptyObj);
        assertTrue("empty array must round-trip as a List", emptyObj instanceof List);
        assertEquals("empty array round-trips as empty List", 0, ((List<?>) emptyObj).size());

        // Clean the row so the single-element assertion below sees exactly one row.
        try (Connection c = getConnection(); Statement s = c.createStatement()) {
            s.execute("DELETE FROM JSONB_ITEM");
        }

        // (b) single-element array.
        ValueObject solo = (ValueObject) mo.newInstance();
        List<Label> one = new ArrayList<>();
        one.add(new Label("solo", 99));
        solo.setObjectArray("labels", one);
        omdb.createObject(oc, solo);

        items = omdb.getObjects(oc, mo);
        assertFalse("Expected the single-element row", items.isEmpty());
        ValueObject loadedSolo = (ValueObject) items.iterator().next();
        List<?> soloLabels = (List<?>) loadedSolo.getObject("labels");
        assertEquals("single-element array size", 1, soloLabels.size());
        Label only = (Label) soloLabels.get(0);
        assertEquals("solo", only.getKey());
        assertEquals(99, only.getWeight());
    }
}
