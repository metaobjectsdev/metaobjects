/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
 * FR-044 — OMDB reads a view-backed object.report: getObjects / getObjectsCount with
 * filter, sort and range on derived fields; by-id and every write refused; a sourceless
 * report not served; nothing changed for a non-report object.
 *
 * The views are created here by literal DDL. That is this test's fixture, not a port
 * emitting SQL: in a real project the view comes from the TypeScript toolchain (ADR-0015).
 */
package com.metaobjects.manager.db;

import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.ObjectRef;
import com.metaobjects.manager.PersistenceException;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.defs.BaseDef;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.manager.exp.Range;
import com.metaobjects.manager.exp.SortOrder;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import com.metaobjects.reporting.ReportReadModel;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.logging.Logger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class ReportReadTest {

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources("test-report", List.of("meta.report.json"));
        registry.registerLoader(loader);

        dbFile = "omb-report-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return ReportReadTest.getConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int s) {}
            @Override public int getLoginTimeout() { return 100; }
            @Override public Logger getParentLogger() { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };

        omdb = new ObjectManagerDB() {
            // A string reference names its object through service-discovered loaders, which a
            // plain unit test does not have; resolve the name against this test's loader instead.
            @Override
            public ObjectRef getObjectRef(String refStr) {
                String rest = refStr.substring("objectref://".length());
                int slash = rest.indexOf('/');
                return new ObjectRef(registry.findMetaObjectByName(rest.substring(0, slash)),
                        new String[] { rest.substring(slash + 1) });
            }

            // An OQL result class is named the same way, and resolved the same way here.
            @Override
            protected MetaObject findResultClass(String className) {
                return registry.findMetaObjectByName(className);
            }
        };
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(ds);
        omdb.init();

        try (Connection c = getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE RPT_SALES (id BIGINT PRIMARY KEY, region VARCHAR(8) NOT NULL,"
                    + " status INTEGER NOT NULL, amountCents BIGINT NOT NULL)");
            s.execute("INSERT INTO RPT_SALES VALUES (1, 'east', 1, 100), (2, 'east', 2, 300), (3, 'west', 1, 50)");
            s.execute("CREATE VIEW RPT_V_BY_REGION (region, sales, revenue, minAmount) AS"
                    + " SELECT region, COUNT(id), SUM(amountCents), MIN(amountCents) FROM RPT_SALES GROUP BY region");
            s.execute("CREATE VIEW RPT_V_BY_STATUS (status, sales) AS"
                    + " SELECT status, COUNT(id) FROM RPT_SALES GROUP BY status");
            s.execute("CREATE VIEW RPT_V_HAND_MADE (sales) AS SELECT COUNT(id) FROM RPT_SALES");
            s.execute("CREATE VIEW RPT_V_PRIMARY (sales) AS SELECT COUNT(id) FROM RPT_SALES");
            // Decoys: a read that lands on the replica, or on a default table name nobody
            // declared, returns a value no real view produces.
            s.execute("CREATE VIEW RPT_V_REPLICA (sales) AS SELECT COUNT(id) + 100 FROM RPT_SALES");
            s.execute("CREATE TABLE REPLICATED_SALES (sales BIGINT)");
            s.execute("INSERT INTO REPLICATED_SALES VALUES (999)");
            // A projection whose view is named by @view (not the legacy @table).
            s.execute("CREATE VIEW RPT_V_SALE_REGIONS (id, region) AS SELECT id, region FROM RPT_SALES");
            s.execute("CREATE TABLE INERT_SALES (sales BIGINT)");
            s.execute("INSERT INTO INERT_SALES VALUES (999)");
            // A @spine report (FR-044): one row per territory, the one no visit names
            // included. The view is written by hand, as the TypeScript toolchain lowers it
            // (ADR-0015: no other port emits SQL): the spine entity LEFT JOINed to the facts,
            // and a defaulted measure wrapped in COALESCE.
            s.execute("CREATE TABLE RPT_TERRITORIES (id BIGINT PRIMARY KEY, name VARCHAR(16) NOT NULL)");
            s.execute("INSERT INTO RPT_TERRITORIES VALUES (10, 'north'), (20, 'south'), (30, 'quiet')");
            s.execute("CREATE TABLE RPT_VISITS (id BIGINT PRIMARY KEY, territoryId BIGINT, minutes BIGINT NOT NULL)");
            s.execute("INSERT INTO RPT_VISITS VALUES (1, 10, 30), (2, 10, 15), (3, 20, 5)");
            s.execute("CREATE VIEW RPT_V_VISITS_BY_TERRITORY"
                    + " (territoryKey, territoryName, visits, totalMinutes, totalMinutesOrZero) AS"
                    + " SELECT t.id, t.name, COUNT(v.id), SUM(v.minutes), COALESCE(SUM(v.minutes), 0)"
                    + " FROM RPT_TERRITORIES t LEFT JOIN RPT_VISITS v ON v.territoryId = t.id GROUP BY t.id, t.name");
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

    private static MetaObject object(String shortName) {
        for (MetaObject mo : loader.getMetaObjects()) {
            if (shortName.equals(mo.getShortName())) return mo;
        }
        throw new AssertionError("no object " + shortName);
    }

    /** Read a report and flatten each row by the read model's fields, in field order. */
    private static List<Map<String, Object>> read(String report, QueryOptions options) {
        MetaObject declared = object(report);
        ObjectConnection oc = omdb.getConnection();
        try {
            List<Map<String, Object>> rows = new ArrayList<>();
            for (Object o : omdb.getObjects(oc, declared, options)) {
                Map<String, Object> row = new LinkedHashMap<>();
                for (MetaField<?> f : omdb.readObjectFor(declared).getMetaFields()) {
                    row.put(f.getName(), f.getObject(o));
                }
                rows.add(row);
            }
            return rows;
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    private static long count(String report, Expression filter) {
        ObjectConnection oc = omdb.getConnection();
        try {
            return omdb.getObjectsCount(oc, object(report), filter);
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    private static Map<String, Object> row(Object... keyValues) {
        Map<String, Object> row = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) row.put((String) keyValues[i], keyValues[i + 1]);
        return row;
    }

    private static QueryOptions sortedBy(String field, int direction) {
        QueryOptions options = new QueryOptions();
        options.setSortOrder(new SortOrder(field, direction));
        return options;
    }

    private static Set<String> columnsOf(ObjectMappingDB mapping) {
        Set<String> columns = new HashSet<>();
        mapping.getArguments().forEach(a -> columns.add(a.getName()));
        return columns;
    }

    private interface Op {
        void run(ObjectConnection oc) throws Exception;
    }

    /** Runs {@code op} and returns the PersistenceException it must throw. */
    private static PersistenceException refused(String what, Op op) throws Exception {
        ObjectConnection oc = omdb.getConnection();
        try {
            op.run(oc);
        } catch (PersistenceException e) {
            return e;
        } finally {
            omdb.releaseConnection(oc);
        }
        fail(what + " must be refused");
        return null;
    }

    private static void assertReadOnlyNoIdentity(String operation, String report, PersistenceException e) {
        String message = e.getMessage();
        assertTrue(message, message.startsWith(operation + " is not supported on [reporttest::" + report + "]"));
        assertTrue(message, message.contains("a report is read-only and has no identity"));
    }

    // ---------------------------------------------------------------------------
    // getObjects / getObjectsCount on a view-backed report
    // ---------------------------------------------------------------------------

    @Test
    public void getObjectsReturnsTheViewsRowsKeyedByDerivedFieldName() {
        List<Map<String, Object>> rows = read("SalesByRegion", sortedBy("region", SortOrder.ASC));
        assertEquals(List.of(
                row("region", "east", "sales", 2L, "revenue", 400L, "minAmount", 100L),
                row("region", "west", "sales", 1L, "revenue", 50L, "minAmount", 50L)), rows);
    }

    @Test
    public void aSpineReportReadsTheEmptyRowWithItsDefaultedMeasure() {
        List<Map<String, Object>> rows = read("VisitsByTerritory", sortedBy("territoryKey", SortOrder.ASC));
        assertEquals(List.of(
                row("territoryKey", 10L, "territoryName", "north", "visits", 2L, "totalMinutes", 45L,
                        "totalMinutesOrZero", 45L),
                row("territoryKey", 20L, "territoryName", "south", "visits", 1L, "totalMinutes", 5L,
                        "totalMinutesOrZero", 5L),
                // The territory no visit names: a count is 0, a measure without @default is null,
                // the defaulted one reads its default.
                row("territoryKey", 30L, "territoryName", "quiet", "visits", 0L, "totalMinutes", null,
                        "totalMinutesOrZero", 0L)), rows);
        // A filter on the defaulted measure matches the empty row by its default (Table G).
        assertEquals(1L, count("VisitsByTerritory", new Expression("totalMinutesOrZero", 0L)));
        // The read model says which columns can never be null (Table C).
        Map<String, Boolean> required = new LinkedHashMap<>();
        for (MetaField<?> f : omdb.readObjectFor(object("VisitsByTerritory")).getMetaFields()) {
            required.put(f.getName(), Boolean.TRUE.equals(f.getMetaAttr(MetaField.ATTR_REQUIRED).getValue()));
        }
        assertEquals("{territoryKey=true, territoryName=true, visits=true, totalMinutes=false, totalMinutesOrZero=true}",
                required.toString());
    }

    @Test
    public void rowsAreInstancesOfTheReadModelNotOfTheDeclaredNode() {
        MetaObject declared = object("SalesByRegion");
        ObjectConnection oc = omdb.getConnection();
        try {
            Object first = omdb.getObjects(oc, declared, new QueryOptions()).iterator().next();
            MetaObject rowMeta = omdb.getMetaObjectFor(first);
            assertTrue(rowMeta instanceof ReportReadModel);
            assertSame(omdb.readObjectFor(declared), rowMeta);
            assertSame("a read model is its own read object", rowMeta, omdb.readObjectFor(rowMeta));
            // The model can be handed back in directly.
            assertEquals(2, omdb.getObjects(oc, rowMeta, new QueryOptions()).size());
            assertEquals(2L, omdb.getObjectsCount(oc, rowMeta, null));
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    @Test
    public void filtersOnADimensionAndOnAMeasure() {
        assertEquals(List.of(row("region", "west", "sales", 1L, "revenue", 50L, "minAmount", 50L)),
                read("SalesByRegion", new QueryOptions(new Expression("region", "west"))));
        assertEquals(List.of(row("region", "east", "sales", 2L, "revenue", 400L, "minAmount", 100L)),
                read("SalesByRegion", new QueryOptions(new Expression("sales", 2L, Expression.EQUAL_GREATER))));
        assertTrue(read("SalesByRegion", new QueryOptions(new Expression("revenue", 1000L, Expression.GREATER))).isEmpty());
    }

    @Test
    public void sortsOnAMeasureWithALimit() {
        QueryOptions options = new QueryOptions();
        options.setSortOrder(new SortOrder("revenue", SortOrder.DESC));
        options.setRange(new Range(1, 1));
        List<Map<String, Object>> rows = read("SalesByRegion", options);
        assertEquals(1, rows.size());
        assertEquals("east", rows.get(0).get("region"));

        options.setSortOrder(new SortOrder("revenue", SortOrder.ASC));
        assertEquals("west", read("SalesByRegion", options).get(0).get("region"));
    }

    @Test
    public void countWorksWithAndWithoutAFilter() {
        assertEquals(2L, count("SalesByRegion", null));
        assertEquals(1L, count("SalesByRegion", new Expression("sales", 2L, Expression.EQUAL_GREATER)));
        assertEquals(0L, count("SalesByRegion", new Expression("region", "north")));
    }

    @Test
    public void rowsAreDecodedByDerivedSubtype_anIntBackedEnumDimensionReadsAndFiltersAsItsSymbol() {
        // The column holds 1 / 2; the derived field carries @values + @intValueMap from Sale.status.
        assertEquals(List.of(row("status", "CLOSED", "sales", 1L), row("status", "OPEN", "sales", 2L)),
                read("SalesByStatus", sortedBy("status", SortOrder.DESC)));
        assertEquals(List.of(row("status", "OPEN", "sales", 2L)),
                read("SalesByStatus", new QueryOptions(new Expression("status", "OPEN"))));
    }

    @Test
    public void anUnknownFieldInAReportFilterOrSortIsRefusedByName() {
        try {
            read("SalesByRegion", new QueryOptions(new Expression("amountCents", 1L)));
            fail("a field of @from is not a field of the report");
        } catch (MetaDataException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("amountCents"));
        }
        try {
            read("SalesByRegion", sortedBy("nope", SortOrder.ASC));
            fail("an unknown sort field must be refused");
        } catch (MetaDataException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("nope"));
        }
    }

    @Test
    public void anUnmanagedReportIsStillRead() {
        assertEquals(List.of(row("sales", 3L)), read("UnmanagedSales", new QueryOptions()));
        assertEquals(1L, count("UnmanagedSales", null));
    }

    @Test
    public void aReplicaDeclaredBeforeThePrimaryView_readsComeFromThePrimaryView() {
        // RPT_V_REPLICA answers 103 and the REPLICATED_SALES fallback table answers 999.
        assertEquals(List.of(row("sales", 3L)), read("ReplicatedSales", new QueryOptions()));
    }

    // ---------------------------------------------------------------------------
    // The mapping
    // ---------------------------------------------------------------------------

    @Test
    public void theMappingIsTheViewWithExactlyTheDerivedColumnsAndNoKeyColumn() {
        ObjectMappingDB mapping = (ObjectMappingDB) omdb.getReadMapping(object("SalesByRegion"));
        assertEquals("RPT_V_BY_REGION", ((BaseDef) mapping.getDBDef()).getNameDef().getName());
        // A mapping's arguments are unordered; the set is what is asserted.
        assertEquals(Set.of("region", "sales", "revenue", "minAmount"), columnsOf(mapping));
        assertSame("the declared node and its model share one mapping",
                mapping, omdb.getReadMapping(omdb.readObjectFor(object("SalesByRegion"))));
    }

    @Test
    public void theNamingStrategyAppliesToTheDerivedFieldName() {
        SimpleMappingHandlerDB handler = new SimpleMappingHandlerDB();
        handler.setColumnNaming("snake_case");
        ObjectMappingDB mapping = (ObjectMappingDB) handler.getReadMapping(omdb.readObjectFor(object("SalesByRegion")));
        assertEquals(Set.of("region", "sales", "revenue", "min_amount"), columnsOf(mapping));
    }

    @Test
    public void theDeclaredReportNodePassedStraightToTheMappingHandlerIsRefusedByName() {
        try {
            new SimpleMappingHandlerDB().getReadMapping(object("SalesByRegion"));
            fail("a declared report has no fields to map");
        } catch (MetaDataException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("Report [reporttest::SalesByRegion] has no fields to map"));
        }
    }

    @Test
    public void aReportIsReadableAndNothingElse() {
        MetaObject report = object("SalesByRegion");
        assertTrue(omdb.isReadableClass(report));
        assertFalse(omdb.isCreateableClass(report));
        assertFalse(omdb.isUpdateableClass(report));
        assertFalse(omdb.isDeleteableClass(report));
        assertFalse("a sourceless report has no read mapping", omdb.isReadableClass(object("InertSales")));
    }

    // ---------------------------------------------------------------------------
    // By-id and every write: read-only, no identity
    // ---------------------------------------------------------------------------

    @Test
    public void byIdAndEveryWriteOnAReportAreRefused_readOnlyNoIdentity() throws Exception {
        MetaObject report = object("SalesByRegion");
        ObjectConnection reader = omdb.getConnection();
        Object row;
        try {
            row = omdb.getObjects(reader, report, new QueryOptions()).iterator().next();
        } finally {
            omdb.releaseConnection(reader);
        }
        // A row read from the view (an instance of the read model) and one built from the declared node.
        Object built = report.newInstance();

        for (Object instance : List.of(row, built)) {
            assertReadOnlyNoIdentity("createObject", "SalesByRegion",
                    refused("createObject", oc -> omdb.createObject(oc, instance)));
            assertReadOnlyNoIdentity("updateObject", "SalesByRegion",
                    refused("updateObject", oc -> omdb.updateObject(oc, instance)));
            assertReadOnlyNoIdentity("deleteObject", "SalesByRegion",
                    refused("deleteObject", oc -> omdb.deleteObject(oc, instance)));
            assertReadOnlyNoIdentity("loadObject", "SalesByRegion",
                    refused("loadObject", oc -> omdb.loadObject(oc, instance)));
            assertReadOnlyNoIdentity("getObjectRef", "SalesByRegion",
                    refused("getObjectRef", oc -> omdb.getObjectRef(instance)));
        }

        assertReadOnlyNoIdentity("deleteObjects", "SalesByRegion",
                refused("deleteObjects", oc -> omdb.deleteObjects(oc, report, new Expression("region", "east"))));
        assertReadOnlyNoIdentity("createObjectsBulk", "SalesByRegion",
                refused("createObjectsBulk", oc -> omdb.createObjectsBulk(oc, report, new ArrayList<>(List.of(built)))));
        assertReadOnlyNoIdentity("updateObjectsBulk", "SalesByRegion",
                refused("updateObjectsBulk", oc -> omdb.updateObjectsBulk(oc, report, new ArrayList<>(List.of(built)))));
        assertReadOnlyNoIdentity("getObjectByRef", "SalesByRegion",
                refused("getObjectByRef", oc -> omdb.getObjectByRef(oc, "objectref://reporttest::SalesByRegion/east")));

        // Nothing was written: the view still answers what the seed rows produce.
        assertEquals(2L, count("SalesByRegion", null));
    }

    // ---------------------------------------------------------------------------
    // A sourceless report is not served
    // ---------------------------------------------------------------------------

    @Test
    public void aSourcelessReportIsNotServed() throws Exception {
        MetaObject inert = object("InertSales");
        // INERT_SALES holds a decoy row: a fallback to a default table name would return it.
        PersistenceException read = refused("getObjects", oc -> omdb.getObjects(oc, inert, new QueryOptions()));
        assertTrue(read.getMessage(), read.getMessage().contains("Report [reporttest::InertSales] is not served"));
        assertTrue(read.getMessage(), read.getMessage().contains("no view to read"));
        PersistenceException counted = refused("getObjectsCount", oc -> omdb.getObjectsCount(oc, inert, null));
        assertTrue(counted.getMessage(), counted.getMessage().contains("is not served"));
    }

    @Test
    public void aWriteOnASourcelessReportIsRefusedAsReadOnlyNotAsUnserved() throws Exception {
        MetaObject inert = object("InertSales");
        assertReadOnlyNoIdentity("createObject", "InertSales",
                refused("createObject", oc -> omdb.createObject(oc, inert.newInstance())));
        assertReadOnlyNoIdentity("deleteObjects", "InertSales",
                refused("deleteObjects", oc -> omdb.deleteObjects(oc, inert, null)));
    }

    // ---------------------------------------------------------------------------
    // Nothing else changes
    // ---------------------------------------------------------------------------

    @Test
    public void readingReportsLeavesTheLoadedModelUntouched() {
        String before = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        int objects = loader.getMetaObjects().size();

        read("SalesByRegion", new QueryOptions());
        read("SalesByStatus", new QueryOptions());
        read("UnmanagedSales", new QueryOptions());
        read("ReplicatedSales", new QueryOptions());
        count("SalesByRegion", null);

        assertEquals(objects, loader.getMetaObjects().size());
        assertEquals(before, CanonicalJsonSerializer.canonicalSerialize(loader.getRoot()));
        assertTrue("the declared node still declares no fields", object("SalesByRegion").getMetaFields().isEmpty());
        assertFalse(loader.getMetaObjects().contains(omdb.readObjectFor(object("SalesByRegion"))));
    }

    @Test
    public void anEntityInTheSameModelIsReadAndWrittenAsBefore() throws Exception {
        MetaObject sale = object("Sale");
        assertSame("a non-report object is its own read object", sale, omdb.readObjectFor(sale));
        assertTrue(omdb.isCreateableClass(sale));

        ObjectConnection oc = omdb.getConnection();
        try {
            ValueObject vo = (ValueObject) sale.newInstance();
            vo.setLong("id", 10L);
            vo.setString("region", "north");
            vo.setString("status", "CLOSED");
            vo.setLong("amountCents", 700L);
            omdb.createObject(oc, vo);
            assertEquals(4L, omdb.getObjectsCount(oc, sale, null));

            ObjectRef ref = omdb.getObjectRef(vo);
            assertNotNull(ref);
            ValueObject byRef = (ValueObject) omdb.getObjectByRef(oc, "objectref://reporttest::Sale/10");
            assertEquals("north", byRef.getString("region"));

            Collection<?> found = omdb.getObjects(oc, sale, new QueryOptions(new Expression("id", 10L)));
            assertEquals(1, found.size());
            ValueObject loaded = (ValueObject) found.iterator().next();
            assertSame(sale, omdb.getMetaObjectFor(loaded));
            assertEquals("CLOSED", loaded.getString("status"));

            loaded.setLong("amountCents", 800L);
            omdb.updateObject(oc, loaded);
            ValueObject reloaded = (ValueObject) sale.newInstance();
            reloaded.setLong("id", 10L);
            omdb.loadObject(oc, reloaded);
            assertEquals(Long.valueOf(800L), reloaded.getLong("amountCents"));

            // The report sees the entity's write through its view, and the entity's delete.
            assertEquals(3L, omdb.getObjectsCount(oc, object("SalesByRegion"), null));
            omdb.deleteObject(oc, reloaded);
            assertEquals(1, omdb.deleteObjects(oc, sale, new Expression("id", 3L)));
            assertEquals(2L, omdb.getObjectsCount(oc, sale, null));
            vo = (ValueObject) sale.newInstance();
            vo.setLong("id", 3L);
            vo.setString("region", "west");
            vo.setString("status", "OPEN");
            vo.setLong("amountCents", 50L);
            omdb.createObject(oc, vo); // restore the seed row the other tests read
            assertEquals(3L, omdb.getObjectsCount(oc, sale, null));
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    // ---------------------------------------------------------------------------
    // OQL with a report as the result class
    // ---------------------------------------------------------------------------

    /** Run an OQL query and flatten each row by the fields of {@code rowShape}. */
    private static List<Map<String, Object>> query(String oql, MetaObject rowShape) {
        ObjectConnection oc = omdb.getConnection();
        try {
            List<Map<String, Object>> rows = new ArrayList<>();
            for (Object o : omdb.executeQuery(oc, oql, new ArrayList<>())) {
                assertSame("an OQL row of a report is an instance of its read model",
                        rowShape, omdb.getMetaObjectFor(o));
                Map<String, Object> row = new LinkedHashMap<>();
                for (MetaField<?> f : rowShape.getMetaFields()) row.put(f.getName(), f.getObject(o));
                rows.add(row);
            }
            return rows;
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    @Test
    public void oqlWithAReportResultClassBuildsRowsFromTheReadModel() {
        MetaObject declared = object("SalesByRegion");
        // The author supplies the SQL; the report supplies the row shape.
        assertEquals(List.of(row("region", "west", "sales", 1L, "revenue", 50L, "minAmount", 50L)),
                // Aliases are quoted because OQL binds a result column by its exact name and
                // Derby upper-cases an unquoted one (true of any OQL result class).
                query("[reporttest::SalesByRegion] SELECT region AS \"region\", sales AS \"sales\","
                        + " revenue AS \"revenue\", minAmount AS \"minAmount\""
                        + " FROM RPT_V_BY_REGION WHERE sales < 2", ReportReadModel.of(declared)));
    }

    @Test
    public void oqlWithASourcelessReportResultClassStillBuildsRows() {
        // InertSales has no view, so it is not served by getObjects; as an OQL result shape
        // it only names the columns, and they bind by derived field name.
        assertEquals(List.of(row("sales", 3L)),
                query("[reporttest::InertSales] SELECT COUNT(id) AS \"sales\" FROM RPT_SALES",
                        ReportReadModel.of(object("InertSales"))));
    }

    // ---------------------------------------------------------------------------
    // A projection declared with @view (the same physical-name rule as a report)
    // ---------------------------------------------------------------------------

    @Test
    public void aProjectionDeclaredWithViewIsReadFromThatView() {
        MetaObject projection = object("SaleRegionView");
        ObjectMappingDB mapping = (ObjectMappingDB) omdb.getReadMapping(projection);
        assertNotNull("a projection whose view is named by @view has a read mapping", mapping);
        assertEquals("RPT_V_SALE_REGIONS", ((BaseDef) mapping.getDBDef()).getNameDef().getName());

        ObjectConnection oc = omdb.getConnection();
        try {
            QueryOptions options = new QueryOptions(new Expression("region", "west"));
            Collection<?> found = omdb.getObjects(oc, projection, options);
            assertEquals(1, found.size());
            assertEquals(Long.valueOf(3L), ((ValueObject) found.iterator().next()).getLong("id"));
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    // ---------------------------------------------------------------------------
    // getObjectRef on an object that is not a report
    // ---------------------------------------------------------------------------

    @Test
    public void getObjectRefOnAnObjectWithNoMetadataFailsExactlyAsTheBaseManagerDoes() {
        Object stranger = new Object();
        Throwable base = null;
        try {
            com.metaobjects.util.MetaDataUtil.findMetaObject(stranger, omdb);
        } catch (RuntimeException e) {
            base = e;
        }
        assertNotNull("the base lookup refuses an object with no metadata", base);
        try {
            omdb.getObjectRef(stranger);
            fail("an object with no metadata has no reference");
        } catch (RuntimeException e) {
            assertSame(base.getClass(), e.getClass());
            assertEquals(base.getMessage(), e.getMessage());
        }
    }
}
