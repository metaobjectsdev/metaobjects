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
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.ReportMetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.reporting.ReportAccessors.ReportDimensionItem;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * FR-044 — the reporting node classes and report accessors in the Java port: the
 * registered classes, the resolving accessors (ADR-0039), the bare-string {@code @of}
 * coercion, the {@code name:grain} parse and the derived report field name.
 */
public class ReportingTest extends SharedRegistryTestBase {

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private static Path corpusRoot() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/conformance");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("fixtures/conformance not found");
    }

    private static MetaRoot loadFixture(String fixture) throws IOException {
        String json = Files.readString(corpusRoot().resolve(fixture).resolve("input/meta.shop.json"),
                StandardCharsets.UTF_8);
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "reporting-test");
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        loader.load(List.of(new InMemoryStringSource(json, "meta.shop.json")));
        assertTrue("no load errors: " + loader.getErrors(), loader.getErrors().isEmpty());
        return loader.getRoot();
    }

    private static MetaObject object(MetaRoot root, String name) {
        for (MetaObject o : root.getChildren(MetaObject.class, false)) {
            if (name.equals(o.getShortName())) return o;
        }
        throw new AssertionError("no object " + name);
    }

    /** A member by class AND name — Purchase has a dimension and a relationship both named program. */
    private static <T extends MetaData> T member(MetaObject entity, Class<T> c, String name) {
        for (T m : entity.getChildren(c, true)) {
            if (name.equals(m.getShortName())) return m;
        }
        throw new AssertionError("no " + c.getSimpleName() + " " + name + " on " + entity.getShortName());
    }

    // ---------------------------------------------------------------------------
    // Registration — each subtype loads as its own node class
    // ---------------------------------------------------------------------------

    @Test
    public void eachSubtypeLoadsAsItsNodeClass() throws IOException {
        MetaRoot root = loadFixture("reporting-vocabulary");
        MetaObject purchase = object(root, "Purchase");
        MetaObject workout = object(root, "WorkoutEvent");

        assertTrue(member(purchase, MetaDimension.class, "program") instanceof AttributeDimension);
        assertTrue(member(purchase, MetaDimension.class, "purchasedAt") instanceof TimeDimension);
        assertTrue(member(purchase, MetaMeasure.class, "revenue") instanceof AggregateMeasure);
        assertTrue(member(workout, MetaMeasure.class, "avgDaysPerStarter") instanceof RatioMeasure);
        assertTrue(member(purchase, MetaSegment.class, "active") instanceof FilterSegment);
        assertTrue(object(root, "DailyRevenue") instanceof ReportMetaObject);
        assertEquals(MetaObject.SUBTYPE_REPORT, object(root, "DailyRevenue").getSubType());
    }

    // ---------------------------------------------------------------------------
    // Dimensions
    // ---------------------------------------------------------------------------

    @Test
    public void dimensionAccessors() throws IOException {
        MetaObject purchase = object(loadFixture("reporting-vocabulary"), "Purchase");

        MetaDimension program = member(purchase, MetaDimension.class, "program");
        assertFalse(program.isTime());
        assertEquals("Purchase.programId", program.getOf());
        assertNull(program.getVia());
        assertEquals(List.of(), program.getGrains());

        MetaDimension title = member(purchase, MetaDimension.class, "programTitle");
        assertEquals("Program.title", title.getOf());
        assertEquals("Purchase.program", title.getVia());

        MetaDimension purchasedAt = member(purchase, MetaDimension.class, "purchasedAt");
        assertTrue(purchasedAt.isTime());
        assertEquals(List.of("day", "week", "month", "quarter", "year"), purchasedAt.getGrains());
    }

    // ---------------------------------------------------------------------------
    // Measures
    // ---------------------------------------------------------------------------

    @Test
    public void aBareStringOfIsAOneColumnList() throws IOException {
        MetaObject purchase = object(loadFixture("reporting-vocabulary"), "Purchase");
        MetaMeasure purchases = member(purchase, MetaMeasure.class, "purchases");
        assertEquals(List.of("Purchase.id"), purchases.getOfColumns());
        assertEquals(ReportingConstants.AGG_COUNT, purchases.getAgg());
        assertFalse(purchases.isDistinct());
        assertEquals("active", purchases.getSegmentName());
        assertNull(purchases.getFilter());
    }

    @Test
    public void aBareStringWithACommaStaysOneItemAndAJsonArrayStillSplitsIntoItems() throws IOException {
        String json = Files.readString(corpusRoot().resolve("reporting-vocabulary/input/meta.shop.json"),
                StandardCharsets.UTF_8)
                .replace("\"@of\": \"Purchase.amountCents\"", "\"@of\": \"Purchase.amountCents,Purchase.id\"");
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "reporting-test-comma");
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        try {
            loader.load(List.of(new InMemoryStringSource(json, "meta.shop.json")));
        } catch (com.metaobjects.MetaDataException expected) {
            // the comma item is an invalid Entity.field (M1); the tree is still built
        }
        MetaObject purchase = object(loader.getRoot(), "Purchase");
        assertEquals(List.of("Purchase.amountCents,Purchase.id"),
                member(purchase, MetaMeasure.class, "revenue").getOfColumns());
        // A JSON-array @of keeps its items.
        assertEquals(List.of("WorkoutEvent.programId", "WorkoutEvent.customerEmail", "WorkoutEvent.weekNumber",
                        "WorkoutEvent.dayNumber"),
                member(object(loader.getRoot(), "WorkoutEvent"), MetaMeasure.class, "daysEngaged").getOfColumns());
    }

    @Test
    public void aListOfIsTheTupleForm() throws IOException {
        MetaObject workout = object(loadFixture("reporting-vocabulary"), "WorkoutEvent");
        MetaMeasure days = member(workout, MetaMeasure.class, "daysEngaged");
        assertEquals(List.of("WorkoutEvent.programId", "WorkoutEvent.customerEmail", "WorkoutEvent.weekNumber",
                        "WorkoutEvent.dayNumber"),
                days.getOfColumns());
        assertTrue(days.isDistinct());
        assertFalse(days.isRatio());
    }

    @Test
    public void ratioAndFilterAccessors() throws IOException {
        MetaRoot root = loadFixture("reporting-vocabulary");
        MetaMeasure ratio = member(object(root, "WorkoutEvent"), MetaMeasure.class, "avgDaysPerStarter");
        assertTrue(ratio.isRatio());
        assertEquals("daysEngaged", ratio.getNumerator());
        assertEquals("starters", ratio.getDenominator());
        assertNull(ratio.getAgg());

        MetaMeasure refunded = member(object(root, "Purchase"), MetaMeasure.class, "refundedPurchases");
        assertEquals(Map.of("refunded", Map.of("eq", true)), refunded.getFilter());

        MetaSegment active = member(object(root, "Purchase"), MetaSegment.class, "active");
        assertEquals(Map.of("status", Map.of("eq", "active")), active.getFilter());
    }

    // ---------------------------------------------------------------------------
    // Inheritance (ADR-0039) — a base member is visible on the concrete entity
    // ---------------------------------------------------------------------------

    @Test
    public void membersDeclaredOnAnAbstractBaseResolveOnTheConcreteEntity() throws IOException {
        MetaRoot root = loadFixture("reporting-inherited-members");
        MetaObject workout = object(root, "WorkoutEvent");
        MetaDimension occurredAt = member(workout, MetaDimension.class, "occurredAt");
        assertEquals("BaseEvent.occurredAt", occurredAt.getOf());
        assertEquals(List.of("day", "week"), occurredAt.getGrains());
        assertNotNull(member(workout, MetaMeasure.class, "events"));
        // Same-named field and dimension coexist on the base: children are keyed by type + name.
        assertNotNull(workout.getChildren(com.metaobjects.field.MetaField.class, true).stream()
                .filter(f -> "occurredAt".equals(f.getShortName())).findFirst().orElse(null));
    }

    // ---------------------------------------------------------------------------
    // Report accessors
    // ---------------------------------------------------------------------------

    @Test
    public void reportAccessors() throws IOException {
        MetaRoot root = loadFixture("reporting-vocabulary");
        MetaObject daily = object(root, "DailyRevenue");
        assertEquals("Purchase", ReportAccessors.reportFrom(daily));
        assertEquals(List.of(new ReportDimensionItem("purchasedAt", "day")), ReportAccessors.reportDimensionItems(daily));
        assertEquals(List.of("purchases", "revenue"), ReportAccessors.reportMeasureNames(daily));

        MetaObject totals = object(root, "StoreTotals");
        assertEquals(List.of(), ReportAccessors.reportDimensionItems(totals));
        assertEquals(List.of(new ReportDimensionItem("program", null)),
                ReportAccessors.reportDimensionItems(object(root, "ProgramEngagement")));
    }

    @Test
    public void derivedFieldName() {
        assertEquals("purchasedAtDay", ReportAccessors.reportDerivedFieldName(new ReportDimensionItem("purchasedAt", "day")));
        assertEquals("createdAtQuarter", ReportAccessors.reportDerivedFieldName(new ReportDimensionItem("createdAt", "quarter")));
        assertEquals("program", ReportAccessors.reportDerivedFieldName(new ReportDimensionItem("program", null)));
        assertEquals("program", ReportAccessors.reportDerivedFieldName(new ReportDimensionItem("program", "")));
    }

    @Test
    public void isoDurationPattern() {
        for (String ok : List.of("-P7D", "P1Y2M", "-PT12H", "+P1W", "P1DT2H30M5S")) {
            assertTrue(ok, ReportingConstants.ISO_DURATION_RE.matcher(ok).matches());
        }
        for (String bad : List.of("P", "PT", "-P", "90 days", "P1H", "7D", "P7D\n")) {
            assertFalse(bad, ReportingConstants.ISO_DURATION_RE.matcher(bad).matches());
        }
    }
}
