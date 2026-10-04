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
package com.metaobjects.reporting;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.source.MetaSource;
import org.junit.BeforeClass;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR-044 — {@link ReportReadModel}: the detached object a runtime reads a report through.
 * Container-free; the database read is gated by the persistence-conformance lane.
 */
public class ReportReadModelTest extends SharedRegistryTestBase {

    private static MetaDataLoader canonicalLoader;
    private static MetaRoot canonical;

    private static Path corpusDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/persistence-conformance");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("fixtures/persistence-conformance not found");
    }

    @BeforeClass
    public static void loadCanonical() {
        canonicalLoader = MetaDataLoader.fromDirectory("report-read-model-test", corpusDir().resolve("canonical"));
        canonical = canonicalLoader.getRoot();
    }

    /** Loads and REGISTERS (so the tree is frozen, as every production load is). */
    private static MetaRoot loadJson(String json) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "report-read-model-inline");
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        loader.load(List.of(new InMemoryStringSource(json, "meta.inline.json")));
        assertTrue("no load errors: " + loader.getErrors(), loader.getErrors().isEmpty());
        loader.register();
        return loader.getRoot();
    }

    private static MetaObject object(MetaRoot root, String name) {
        // ADR-0039: own — the root's own children in declaration order (a root has no super).
        for (MetaObject o : root.getChildren(MetaObject.class, false)) {
            if (name.equals(o.getShortName())) return o;
        }
        throw new AssertionError("no object " + name);
    }

    private static List<String> fieldNames(MetaObject o) {
        List<String> names = new ArrayList<>();
        for (MetaField<?> f : o.getMetaFields()) names.add(f.getName());
        return names;
    }

    private static boolean required(MetaField<?> f) {
        return Boolean.TRUE.equals(f.getMetaAttr(MetaField.ATTR_REQUIRED).getValue());
    }

    // ---------------------------------------------------------------------------
    // Shape
    // ---------------------------------------------------------------------------

    @Test
    public void carriesOneRealFieldPerTableBRowInOrder() {
        ReportReadModel model = ReportReadModel.of(object(canonical, "ProgramMinutes"), canonical);
        assertEquals(
                List.of("program", "programTitle", "weeks", "longWeeks", "labels", "slots", "totalMinutes",
                        "avgMinutes", "minMinutes", "maxMinutes", "longShare"),
                fieldNames(model));
        assertEquals("long", model.getMetaField("program").getSubType());
        assertEquals("string", model.getMetaField("programTitle").getSubType());
        assertEquals("long", model.getMetaField("weeks").getSubType());
        assertEquals("decimal", model.getMetaField("avgMinutes").getSubType());
        assertEquals("min keeps the @of field's subtype", "int", model.getMetaField("minMinutes").getSubType());
        assertEquals("decimal", model.getMetaField("longShare").getSubType());
    }

    @Test
    public void requiredComesFromTheShapeNotFromTheTypeSource() {
        ReportReadModel model = ReportReadModel.of(object(canonical, "ProgramMinutes"), canonical);
        assertTrue(required(model.getMetaField("program")));
        assertFalse("reached by @via", required(model.getMetaField("programTitle")));
        assertTrue("a count is never null", required(model.getMetaField("weeks")));
        // Week.durationMinutes is @required, yet a min over it is nullable (an empty group).
        assertFalse(required(model.getMetaField("minMinutes")));
    }

    @Test
    public void keepsTheReportsNamePackageAndSubtypeAndHasNoIdentity() {
        MetaObject report = object(canonical, "ProgramMinutes");
        ReportReadModel model = ReportReadModel.of(report, canonical);
        assertEquals(report.getName(), model.getName());
        assertEquals("ProgramMinutes", model.getShortName());
        assertEquals("fitness", model.getPackage());
        assertEquals(MetaObject.SUBTYPE_REPORT, model.getSubType());
        assertTrue(ReportReadModel.isReport(model));
        assertTrue(ReportReadModel.isReport(report));
        assertFalse(ReportReadModel.isReport(object(canonical, "Week")));
        assertNull("a report has no primary key", model.getPrimaryIdentity());
        assertSame(report, model.report());
        assertTrue(model.isFrozen());
    }

    // ---------------------------------------------------------------------------
    // Type-shaping attrs (Table B)
    // ---------------------------------------------------------------------------

    @Test
    public void anEnumDimensionCarriesItsValues() {
        MetaField<?> status = ReportReadModel.of(object(canonical, "ProgramsByMonth"), canonical).getMetaField("status");
        assertEquals("enum", status.getSubType());
        assertEquals(
                object(canonical, "Program").getMetaField("status").getMetaAttr(EnumField.ATTR_VALUES).getValue(),
                status.getMetaAttr(EnumField.ATTR_VALUES).getValue());
    }

    @Test
    public void theHourBucketCarriesLocalTimeAndADateBucketCarriesNothing() {
        ReportReadModel model = ReportReadModel.of(object(canonical, "AssetActivity"), canonical);
        MetaField<?> source = object(canonical, "Asset").getMetaField("recordedAt");
        MetaField<?> hour = model.getMetaField("recordedAtHour");
        assertEquals("timestamp", hour.getSubType());
        assertEquals(source.hasMetaAttr(CoreDBMetaDataProvider.LOCAL_TIME), hour.hasMetaAttr(CoreDBMetaDataProvider.LOCAL_TIME));
        MetaField<?> week = model.getMetaField("asOfDateWeek");
        assertEquals("date", week.getSubType());
        assertEquals("only @required", 1, week.getMetaAttrs().size());
    }

    private static final String SALES_MODEL = """
        { "metadata.root": { "package": "shop", "children": [
          { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.currency": { "name": "amountCents", "@required": true, "@currency": "EUR" } }
          ] } },
          { "object.entity": { "name": "Sale", "extends": "Base", "children": [
            { "source.rdb": { "@table": "sales" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.string": { "name": "region", "@required": true, "@maxLength": 8, "@column": "region_code" } },
            { "field.string": { "name": "payload", "@dbColumnType": "jsonb" } },
            { "dimension.attribute": { "name": "region", "@of": "Sale.region" } },
            { "dimension.attribute": { "name": "payload", "@of": "Sale.payload" } },
            { "measure.aggregate": { "name": "revenue", "@agg": "sum", "@of": "Sale.amountCents" } },
            { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
          ] } },
          { "object.report": { "name": "SalesByRegion", "@from": "Sale", "@dimensions": ["region", "payload"],
              "@measures": ["revenue", "sales"], "children": [
            { "source.rdb": { "name": "replica", "@kind": "view", "@view": "v_sales_replica", "@role": "replica" } },
            { "source.rdb": { "name": "main", "@kind": "view", "@view": "v_sales_by_region", "@schema": "rpt" } }
          ] } },
          { "object.report": { "name": "UnmanagedSales", "@from": "Sale", "@measures": ["sales"], "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_hand_made", "@unmanaged": true } }
          ] } },
          { "object.report": { "name": "InertSales", "@from": "Sale", "@measures": ["sales"] } }
        ] } }
        """;

    @Test
    public void carriesOnlyTheTypeShapingAttrsAndNeverTheColumn() {
        MetaRoot root = loadJson(SALES_MODEL);
        ReportReadModel model = ReportReadModel.of(object(root, "SalesByRegion"), root);

        MetaField<?> region = model.getMetaField("region");
        assertEquals("8", region.getMetaAttr(MetaField.ATTR_MAX_LENGTH).getValueAsString());
        assertFalse("@column on the @of field is never inherited: the column is the derived name",
                region.hasMetaAttr(CoreDBMetaDataProvider.COLUMN));

        MetaField<?> revenue = model.getMetaField("revenue");
        assertEquals("currency", revenue.getSubType());
        assertEquals("a sum of currency carries @currency, here inherited through extends",
                "EUR", revenue.getMetaAttr(CurrencyField.ATTR_CURRENCY).getValueAsString());
        assertFalse(required(revenue));

        assertEquals("jsonb", model.getMetaField("payload").getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE).getValueAsString());
    }

    // ---------------------------------------------------------------------------
    // The source
    // ---------------------------------------------------------------------------

    @Test
    public void theCanonicalReportsResolveTheirRelationToTheDeclaredView() {
        assertEquals("v_program_minutes", ReportReadModel.of(object(canonical, "ProgramMinutes"), canonical).viewName());
        assertEquals("v_fitness_totals", ReportReadModel.of(object(canonical, "FitnessTotals"), canonical).viewName());
        assertEquals("v_asset_activity", ReportReadModel.of(object(canonical, "AssetActivity"), canonical).viewName());
    }

    @Test
    public void aReplicaDeclaredBeforeThePrimaryViewIsNotTheOneRead() {
        MetaRoot root = loadJson(SALES_MODEL);
        MetaObject report = object(root, "SalesByRegion");
        ReportReadModel model = ReportReadModel.of(report, root);

        assertTrue(model.isServed());
        assertEquals("v_sales_by_region", model.viewName());
        List<MetaSource> sources = new ArrayList<>(model.getSources());
        assertEquals("the copy is the model's only source", 1, sources.size());
        MetaSource copy = sources.get(0);
        assertEquals(MetaSource.ROLE_PRIMARY, copy.getRole());
        assertEquals(MetaSource.KIND_VIEW, copy.getEffectiveKind());
        assertEquals("the source's other attrs are carried", "rpt", copy.getSchema());

        // The loaded source is copied, never re-parented.
        MetaSource declared = ReportShape.readSource(report);
        assertNotSame(declared, copy);
        assertSame(report, (MetaData) declared.getParent());
        assertSame(model, (MetaData) copy.getParent());
        // ADR-0039: own — counting the sources the report itself declares.
        assertEquals(2, report.getSources(false).size());
    }

    @Test
    public void anUnmanagedSourceIsCopiedLikeAnyOther() {
        MetaRoot root = loadJson(SALES_MODEL);
        ReportReadModel model = ReportReadModel.of(object(root, "UnmanagedSales"), root);
        assertTrue(model.isServed());
        assertEquals("v_hand_made", model.viewName());
        assertTrue(model.getSources().iterator().next().isUnmanaged());
    }

    @Test
    public void aSourcelessReportHasAShapeAndNoView() {
        MetaRoot root = loadJson(SALES_MODEL);
        ReportReadModel model = ReportReadModel.of(object(root, "InertSales"), root);
        assertEquals(List.of("sales"), fieldNames(model));
        assertFalse(model.isServed());
        assertNull(model.viewName());
        assertTrue(model.getSources().isEmpty());
    }

    // ---------------------------------------------------------------------------
    // Detached, and the loaded tree untouched
    // ---------------------------------------------------------------------------

    @Test
    public void isDetachedAndLeavesTheLoadedModelUntouched() {
        String before = CanonicalJsonSerializer.canonicalSerialize(canonical);
        int objectsBefore = canonicalLoader.getMetaObjects().size();
        int childrenBefore = canonical.getChildren().size();

        List<ReportReadModel> models = new ArrayList<>();
        // ADR-0039: own — the root's own children in declaration order (a root has no super).
        for (MetaObject o : canonical.getChildren(MetaObject.class, false)) {
            if (ReportReadModel.isReport(o)) models.add(ReportReadModel.of(o, canonical));
        }
        assertEquals(6, models.size());

        for (ReportReadModel model : models) {
            assertNull("never attached", model.getParent());
            assertFalse(canonical.getChildren().contains(model));
            assertFalse(canonicalLoader.getMetaObjects().contains(model));
            assertTrue("the declared node still declares no fields", model.report().getMetaFields().isEmpty());
        }
        assertEquals(objectsBefore, canonicalLoader.getMetaObjects().size());
        assertEquals(childrenBefore, canonical.getChildren().size());
        assertEquals(before, CanonicalJsonSerializer.canonicalSerialize(canonical));
    }

    @Test
    public void isCachedPerReportNodeAndIdempotent() {
        MetaObject report = object(canonical, "FitnessTotals");
        ReportReadModel model = ReportReadModel.of(report, canonical);
        assertSame(model, ReportReadModel.of(report, canonical));
        assertSame(model, ReportReadModel.of(report));
        assertSame("a read model is its own read model", model, ReportReadModel.of(model));
        assertNotSame(model, ReportReadModel.of(object(canonical, "ProgramMinutes"), canonical));
    }

    // ---------------------------------------------------------------------------
    // A derived field over a field.object is refused by name
    // ---------------------------------------------------------------------------

    private static final String OBJECT_DIMENSION_MODEL = """
        { "metadata.root": { "package": "shop", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "city" } }
          ] } },
          { "object.entity": { "name": "Sale", "children": [
            { "source.rdb": { "@table": "sales" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            { "field.object": { "name": "shipTo", "@objectRef": "Address", "@storage": "jsonb" } },
            { "dimension.attribute": { "name": "destination", "@of": "Sale.shipTo" } },
            { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
          ] } },
          { "object.report": { "name": "SalesByDestination", "@from": "Sale",
              "@dimensions": ["destination"], "@measures": ["sales"], "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_sales_by_destination" } }
          ] } }
        ] } }
        """;

    @Test
    public void aDimensionOverAFieldObjectIsRefusedByName() {
        MetaRoot root = loadJson(OBJECT_DIMENSION_MODEL);
        MetaObject report = object(root, "SalesByDestination");
        // The shape still derives (the loader accepts the model); the read model refuses.
        assertEquals("object", ReportShape.of(report, root).fields().get(0).subType());
        try {
            ReportReadModel.of(report, root);
            fail("a report over a field.object must be refused");
        } catch (MetaDataException e) {
            assertEquals("report 'SalesByDestination': dimension 'destination' reads 'shop::Sale.shipTo',"
                    + " a field.object. A report over a field.object is not supported; group by a scalar field.",
                    e.getMessage());
        }
    }
}
