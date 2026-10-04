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
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR-044 — {@link ReportShape} (contract Table B) in the Java port. The gate is the
 * byte-comparison with {@code fixtures/persistence-conformance/report-shapes.json}, the
 * committed TypeScript-produced artifact every port derives from the same canonical model.
 * Container-free: metadata in, JSON out.
 */
public class ReportShapeTest extends SharedRegistryTestBase {

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
        canonical = MetaDataLoader.fromDirectory("report-shape-test", corpusDir().resolve("canonical")).getRoot();
    }

    private static MetaRoot loadJson(String json) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "report-shape-inline");
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        loader.load(List.of(new InMemoryStringSource(json, "meta.inline.json")));
        assertTrue("no load errors: " + loader.getErrors(), loader.getErrors().isEmpty());
        return loader.getRoot();
    }

    private static MetaObject object(MetaRoot root, String name) {
        // ADR-0039: own — the root's own children in declaration order (a root has no super).
        for (MetaObject o : root.getChildren(MetaObject.class, false)) {
            if (name.equals(o.getShortName())) return o;
        }
        throw new AssertionError("no object " + name);
    }

    private static ReportShape.Field field(ReportShape shape, String name) {
        for (ReportShape.Field f : shape.fields()) {
            if (name.equals(f.name())) return f;
        }
        throw new AssertionError("no derived field " + name);
    }

    // ---------------------------------------------------------------------------
    // The artifact — every port serialises the same bytes
    // ---------------------------------------------------------------------------

    private static String quote(String s) {
        return s == null ? "null" : "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /** The artifact's bytes for a loaded model: the format documented in the TypeScript
     *  generator ({@code integration-tests/src/gen-report-shapes.ts}). */
    private static String shapesJson(MetaRoot root) {
        StringBuilder b = new StringBuilder("{\n  \"reports\": [");
        boolean firstReport = true;
        // ADR-0039: own — the root's own children in declaration order (a root has no super).
        for (MetaObject report : root.getChildren(MetaObject.class, false)) {
            if (!MetaObject.SUBTYPE_REPORT.equals(report.getSubType())) continue;
            ReportShape shape = ReportShape.of(report, root);
            b.append(firstReport ? "\n" : ",\n");
            firstReport = false;
            b.append("    {\n");
            b.append("      \"report\": ").append(quote(report.getName())).append(",\n");
            b.append("      \"from\": ").append(quote(shape.from().getName())).append(",\n");
            b.append("      \"view\": ").append(quote(shape.viewName())).append(",\n");
            b.append("      \"fields\": [");
            boolean firstField = true;
            for (ReportShape.Field f : shape.fields()) {
                b.append(firstField ? "\n" : ",\n");
                firstField = false;
                b.append("        {\n");
                b.append("          \"name\": ").append(quote(f.name())).append(",\n");
                b.append("          \"role\": ").append(quote(f.role().wireName())).append(",\n");
                b.append("          \"subType\": ").append(quote(f.subType())).append(",\n");
                b.append("          \"required\": ").append(f.required()).append(",\n");
                b.append("          \"typeSource\": ").append(quote(f.typeSourceKey())).append("\n");
                b.append("        }");
            }
            b.append(firstField ? "]\n" : "\n      ]\n");
            b.append("    }");
        }
        b.append(firstReport ? "]\n" : "\n  ]\n");
        return b.append("}\n").toString();
    }

    @Test
    public void canonicalShapesByteMatchTheCommittedArtifact() throws IOException {
        String expected = Files.readString(corpusDir().resolve("report-shapes.json"), StandardCharsets.UTF_8);
        assertEquals(expected, shapesJson(canonical));
    }

    // ---------------------------------------------------------------------------
    // Table B, row by row, on the canonical reports
    // ---------------------------------------------------------------------------

    @Test
    public void fieldsAreDimensionsThenMeasuresInListedOrder() {
        ReportShape shape = ReportShape.of(object(canonical, "ProgramMinutes"), canonical);
        assertEquals(
                List.of("program", "programTitle", "weeks", "longWeeks", "labels", "slots", "totalMinutes",
                        "avgMinutes", "minMinutes", "maxMinutes", "longShare"),
                shape.fields().stream().map(ReportShape.Field::name).collect(Collectors.toList()));
        assertSame(object(canonical, "ProgramMinutes"), shape.report());
        assertSame(object(canonical, "Week"), shape.from());
        assertEquals("v_program_minutes", shape.viewName());
    }

    @Test
    public void attributeDimensionKeepsTheOfFieldsSubtypeAndIsRequiredOnlyWithoutVia() {
        ReportShape shape = ReportShape.of(object(canonical, "ProgramMinutes"), canonical);

        ReportShape.Field program = field(shape, "program");
        assertEquals(ReportShape.Role.DIMENSION, program.role());
        assertEquals("long", program.subType());
        assertTrue("no @via and a required @of field", program.required());
        assertEquals("fitness::Week.programId", program.typeSourceKey());
        assertNotNull(program.dimension());
        assertNull(program.grain());
        assertNull(program.measure());

        ReportShape.Field title = field(shape, "programTitle");
        assertEquals("string", title.subType());
        assertFalse("reached by @via, so nullable", title.required());
        assertEquals("fitness::Program.title", title.typeSourceKey());
    }

    @Test
    public void measureRowsOfTableB() {
        ReportShape shape = ReportShape.of(object(canonical, "ProgramMinutes"), canonical);

        ReportShape.Field count = field(shape, "weeks");
        assertEquals(ReportShape.Role.MEASURE, count.role());
        assertEquals("long", count.subType());
        assertTrue("a count is never null", count.required());
        assertNull(count.typeSource());
        assertNotNull(count.measure());

        assertEquals("long", field(shape, "labels").subType());   // count + @distinct
        assertEquals("long", field(shape, "slots").subType());    // tuple count
        assertEquals("long", field(shape, "totalMinutes").subType()); // sum of int
        assertFalse(field(shape, "totalMinutes").required());
        assertNull(field(shape, "totalMinutes").typeSource());
        assertEquals("decimal", field(shape, "avgMinutes").subType());

        ReportShape.Field min = field(shape, "minMinutes");
        assertEquals("min keeps the @of field's subtype", "int", min.subType());
        assertFalse(min.required());
        assertEquals("fitness::Week.durationMinutes", min.typeSourceKey());

        ReportShape.Field ratio = field(shape, "longShare");
        assertEquals("decimal", ratio.subType());
        assertFalse(ratio.required());
        assertNull(ratio.typeSource());
    }

    @Test
    public void timeDimensionIsNamedByGrainAndTypedByGrain() {
        ReportShape byMonth = ReportShape.of(object(canonical, "ProgramsByMonth"), canonical);
        ReportShape.Field month = byMonth.fields().get(0);
        assertEquals("createdAtMonth", month.name());
        assertEquals("date", month.subType());
        assertEquals("month", month.grain());
        assertNull("a date bucket carries no type source", month.typeSource());

        ReportShape activity = ReportShape.of(object(canonical, "AssetActivity"), canonical);
        ReportShape.Field hour = field(activity, "recordedAtHour");
        assertEquals("timestamp", hour.subType());
        assertEquals("hour", hour.grain());
        assertEquals("the hour bucket carries @localTime from the @of field",
                "fitness::Asset.recordedAt", hour.typeSourceKey());
        assertEquals("date", field(activity, "asOfDateWeek").subType());
    }

    @Test
    public void aReportWithNoDimensionsHasOnlyMeasures() {
        ReportShape shape = ReportShape.of(object(canonical, "FitnessTotals"), canonical);
        assertEquals(List.of("weeks", "totalMinutes", "longShare"),
                shape.fields().stream().map(ReportShape.Field::name).collect(Collectors.toList()));
        for (ReportShape.Field f : shape.fields()) assertEquals(ReportShape.Role.MEASURE, f.role());
    }

    @Test
    public void theRootIsFoundFromTheReportWhenNotPassed() {
        MetaObject report = object(canonical, "ProgramsByWeek");
        assertEquals(
                ReportShape.of(report, canonical).fields().stream().map(ReportShape.Field::name).collect(Collectors.toList()),
                ReportShape.of(report).fields().stream().map(ReportShape.Field::name).collect(Collectors.toList()));
    }

    // ---------------------------------------------------------------------------
    // Rows the canonical model does not exercise
    // ---------------------------------------------------------------------------

    private static final String SALES_MODEL = """
        { "metadata.root": { "package": "shop", "children": [
          { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.currency": { "name": "amountCents", "@required": true, "@currency": "USD" } }
          ] } },
          { "object.entity": { "name": "Sale", "extends": "Base", "children": [
            { "source.rdb": { "@table": "sales" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.decimal": { "name": "weight", "@precision": 10, "@scale": 2 } },
            { "field.double": { "name": "score" } },
            { "field.float": { "name": "ratio" } },
            { "field.string": { "name": "region", "@required": true, "@maxLength": 8 } },
            { "dimension.attribute": { "name": "region", "@of": "Sale.region" } },
            { "measure.aggregate": { "name": "revenue", "@agg": "sum", "@of": "Sale.amountCents" } },
            { "measure.aggregate": { "name": "avgRevenue", "@agg": "avg", "@of": "Sale.amountCents" } },
            { "measure.aggregate": { "name": "totalWeight", "@agg": "sum", "@of": "Sale.weight" } },
            { "measure.aggregate": { "name": "avgWeight", "@agg": "avg", "@of": "Sale.weight" } },
            { "measure.aggregate": { "name": "totalScore", "@agg": "sum", "@of": "Sale.score" } },
            { "measure.aggregate": { "name": "avgScore", "@agg": "avg", "@of": "Sale.score" } },
            { "measure.aggregate": { "name": "totalRatio", "@agg": "sum", "@of": "Sale.ratio" } },
            { "measure.aggregate": { "name": "avgRatio", "@agg": "avg", "@of": "Sale.ratio" } },
            { "measure.aggregate": { "name": "maxRevenue", "@agg": "max", "@of": "Sale.amountCents" } }
          ] } },
          { "object.report": { "name": "SalesByRegion", "@from": "Sale", "@dimensions": ["region"],
              "@measures": ["revenue", "avgRevenue", "totalWeight", "avgWeight", "totalScore", "avgScore",
                            "totalRatio", "avgRatio", "maxRevenue"] } }
        ] } }
        """;

    @Test
    public void sumAndAvgRowsByOfSubtype() {
        MetaRoot root = loadJson(SALES_MODEL);
        ReportShape shape = ReportShape.of(object(root, "SalesByRegion"), root);

        ReportShape.Field revenue = field(shape, "revenue");
        assertEquals("currency", revenue.subType());
        assertNotNull("sum of currency carries @currency from the @of field", revenue.typeSource());
        assertEquals("decimal", field(shape, "avgRevenue").subType());
        assertEquals("decimal", field(shape, "totalWeight").subType());
        assertEquals("decimal", field(shape, "avgWeight").subType());
        assertEquals("double", field(shape, "totalScore").subType());
        assertEquals("double", field(shape, "avgScore").subType());
        assertEquals("double", field(shape, "totalRatio").subType());
        assertEquals("double", field(shape, "avgRatio").subType());
        assertEquals("currency", field(shape, "maxRevenue").subType());
        assertTrue("no @via and a required @of field", field(shape, "region").required());
        assertNull("a sourceless report has no view", shape.viewName());
    }

    @Test
    public void anInheritedOfFieldIsFoundAndItsTypeSourceNamesTheDeclaringEntity() {
        MetaRoot root = loadJson(SALES_MODEL);
        ReportShape.Field revenue = field(ReportShape.of(object(root, "SalesByRegion"), root), "revenue");
        MetaField<?> typeSource = revenue.typeSource();
        assertEquals("amountCents", typeSource.getName());
        assertSame("the field lives on the base that declares it", object(root, "Base"), (MetaData) typeSource.getParent());
        assertEquals("shop::Base.amountCents", revenue.typeSourceKey());
    }

    @Test
    public void anUnresolvedReferenceNamesTheReport() {
        MetaRoot root = loadJson(SALES_MODEL);
        // A report built in code (never added to the root), naming a measure that does not exist.
        com.metaobjects.object.ReportMetaObject stray = new com.metaobjects.object.ReportMetaObject("shop::Stray");
        stray.addMetaAttr(com.metaobjects.attr.StringAttribute.create(MetaObject.ATTR_REPORT_FROM, "Sale"));
        com.metaobjects.attr.StringArrayAttribute measures =
                new com.metaobjects.attr.StringArrayAttribute(MetaObject.ATTR_REPORT_MEASURES);
        measures.setValue(List.of("nope"));
        stray.addMetaAttr(measures);
        try {
            ReportShape.of(stray, root);
            fail("an unresolved measure must throw");
        } catch (MetaDataException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("report 'Stray'"));
            assertTrue(e.getMessage(), e.getMessage().contains("measure 'nope'"));
        }
    }
}
