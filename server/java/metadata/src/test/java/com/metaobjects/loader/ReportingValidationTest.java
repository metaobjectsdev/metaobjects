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
package com.metaobjects.loader;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.reporting.MetaSegment;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * FR-044 — the Java port of the reporting validation pass ({@link ReportingValidation}).
 *
 * <p>The shared conformance corpus already gates each rule's CODE and SOURCE. This test
 * gates what the corpus does not: the exact MESSAGE TEXT (every port emits the TypeScript
 * reference's wording — the table below is the TS loader's output over the same
 * fixtures), the one-error-per-broken-rule guarantee before the loader's envelope dedupe
 * collapses same-node findings, the inheritance dedupe, and the relative-date desugar.</p>
 */
public class ReportingValidationTest extends SharedRegistryTestBase {

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
        throw new AssertionError("fixtures/conformance not found above " + Paths.get("").toAbsolutePath());
    }

    private static MetaDataLoader strictLoader(String name) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        return loader;
    }

    /** Load the sources, tolerating the validation-phase throw, and return the built tree. */
    private static MetaRoot loadTree(List<MetaDataSource> sources) {
        MetaDataLoader loader = strictLoader("reporting-validation-test");
        try {
            loader.load(sources);
        } catch (MetaDataException expected) {
            // A model with a reporting defect fails the load; the tree is still built.
        }
        MetaRoot root = loader.getRoot();
        assertNotNull("loader built a tree", root);
        return root;
    }

    private static MetaRoot loadJson(JsonObject doc) {
        return loadTree(List.of(new InMemoryStringSource(new Gson().toJson(doc), "meta.shop.json")));
    }

    private static List<String> codes(List<MetaDataException> errors) {
        return errors.stream().map(e -> e.getCode().map(Enum::name).orElse("?")).collect(Collectors.toList());
    }

    private static JsonObject fixtureDoc(String fixture) throws IOException {
        Path file = corpusRoot().resolve(fixture).resolve("input/meta.shop.json");
        return JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
    }

    /** The positive fixture's model, to edit one thing at a time. */
    private static JsonObject cleanModel() throws IOException {
        return fixtureDoc("reporting-vocabulary");
    }

    private static JsonArray rootChildren(JsonObject doc) {
        return doc.getAsJsonObject("metadata.root").getAsJsonArray("children");
    }

    /** The body of a root-level node keyed {@code typeKey} with {@code name}. */
    private static JsonObject rootNode(JsonObject doc, String typeKey, String name) {
        for (JsonElement w : rootChildren(doc)) {
            JsonObject body = w.getAsJsonObject().getAsJsonObject(typeKey);
            if (body != null && name.equals(body.get("name").getAsString())) return body;
        }
        throw new AssertionError("no " + typeKey + " " + name);
    }

    /** The body of a member keyed {@code typeKey} (e.g. "measure.aggregate") named {@code name}
     *  on entity {@code entity}. Keyed by type AND name: Purchase has a dimension and a
     *  relationship both named {@code program}. */
    private static JsonObject member(JsonObject doc, String entity, String typeKey, String name) {
        for (JsonElement w : rootNode(doc, "object.entity", entity).getAsJsonArray("children")) {
            JsonObject body = w.getAsJsonObject().getAsJsonObject(typeKey);
            if (body != null && body.has("name") && name.equals(body.get("name").getAsString())) return body;
        }
        throw new AssertionError("no " + typeKey + " " + name + " on " + entity);
    }

    private static JsonObject json(String text) {
        return JsonParser.parseString(text).getAsJsonObject();
    }

    // ---------------------------------------------------------------------------
    // Every error fixture: exactly one finding, with the TS reference's code + text
    // ---------------------------------------------------------------------------

    @Test
    public void everyErrorFixtureYieldsTheReferenceCodeAndMessage() throws IOException {
        Map<String, String[]> expect = new LinkedHashMap<>();
        expect.put("error-dimension-grain-on-date", new String[]{"ERR_INVALID_DIMENSION",
                "dimension 'purchasedOn' on entity 'acme::shop::Purchase': grain 'hour' is impossible on 'Purchase.purchasedOn', a field.date (a date has no hour). Remove 'hour' from @grains."});
        expect.put("error-dimension-of-unresolved", new String[]{"ERR_INVALID_DIMENSION",
                "dimension 'program' on entity 'acme::shop::Purchase': @of 'Purchase.programIdd' names no field 'programIdd' on 'acme::shop::Purchase'."});
        expect.put("error-dimension-time-not-temporal", new String[]{"ERR_INVALID_DIMENSION",
                "dimension 'purchasedAt' on entity 'acme::shop::Purchase': a time dimension's @of must be a field.date or field.timestamp, but 'Purchase.status' is field.string."});
        expect.put("error-dimension-via-to-many", new String[]{"ERR_INVALID_DIMENSION",
                "dimension 'buyerEmail' on entity 'acme::shop::Program': @via 'Program.purchases' crosses relationship 'purchases' on 'acme::shop::Program', which is not to-one. A dimension follows only @cardinality: one relationships and identity.reference hops, so grouping can never multiply the measured rows."});
        expect.put("error-measure-distinct-not-count", new String[]{"ERR_INVALID_MEASURE",
                "measure 'revenue' on entity 'acme::shop::Purchase': @distinct: true requires @agg: count, not 'sum'."});
        expect.put("error-measure-of-foreign", new String[]{"ERR_INVALID_MEASURE",
                "measure 'buyers' on entity 'acme::shop::Purchase': @of 'WorkoutEvent.customerEmail' must name a field of the owning entity 'acme::shop::Purchase'. A measure aggregates its own entity's rows; declare it on the entity that owns the column."});
        expect.put("error-measure-segment-unresolved", new String[]{"ERR_INVALID_MEASURE",
                "measure 'revenue' on entity 'acme::shop::Purchase': @segment 'completions' names no segment of 'acme::shop::Purchase'."});
        expect.put("error-measure-sum-non-numeric", new String[]{"ERR_INVALID_MEASURE",
                "measure 'revenue' on entity 'acme::shop::Purchase': @agg 'sum' needs a numeric field (field.int, long, double, float, decimal or currency), but 'Purchase.status' is field.string."});
        expect.put("error-measure-tuple-without-distinct", new String[]{"ERR_INVALID_MEASURE",
                "measure 'daysEngaged' on entity 'acme::shop::WorkoutEvent': @of lists 4 columns; a tuple is legal only with @agg: count and @distinct: true (a distinct count of the tuple)."});
        expect.put("error-ratio-operand-not-aggregate", new String[]{"ERR_INVALID_MEASURE",
                "measure 'ratioOfRatio' on entity 'acme::shop::WorkoutEvent': @numerator 'avgDaysPerStarter' is a measure.ratio; a ratio's operands must be measure.aggregate (a ratio of ratios is not supported)."});
        expect.put("error-relative-date-bad-duration", new String[]{"ERR_BAD_ATTR_FILTER",
                "report 'acme::shop::DailyRevenue': @filter on 'purchasedAt' has relative date '90 days', which is not an ISO-8601 duration (e.g. '-P7D', '-PT12H')."});
        expect.put("error-relative-date-non-temporal", new String[]{"ERR_BAD_ATTR_FILTER",
                "report 'acme::shop::DailyRevenue': @filter on 'amountCents' uses a relative date ({ now: ... }), but 'amountCents' is field.currency; relative dates apply only to field.date and field.timestamp."});
        expect.put("error-relative-date-wrong-host", new String[]{"ERR_BAD_ATTR_FILTER",
                "object.projection 'acme::shop::RecentPurchase': @filter uses a relative date ({ now: ... }), which is legal only in the @filter of a segment, measure.aggregate or object.report."});
        expect.put("error-report-declares-field", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::StoreTotals' declares field.long 'rowCount'; a report's fields and identity are derived from @dimensions and @measures, never declared."});
        expect.put("error-report-dimension-grain", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::DailyRevenue': @dimensions item 'purchasedAt:hour' uses grain 'hour', which time dimension 'purchasedAt' does not declare. Its @grains: day, week, month, quarter, year."});
        expect.put("error-report-field-collision", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::DailyRevenue': dimension item 'purchasedAt:day' and measure 'purchasedAtDay' both derive report field 'purchasedAtDay'. Report field names must be unique; rename the measure or drop one item."});
        expect.put("error-report-foreign-measure", new String[]{"ERR_REPORT_FOREIGN_MEASURE",
                "report 'acme::shop::DailyRevenue' lists measure 'starters', which belongs to 'acme::shop::WorkoutEvent', not @from 'acme::shop::Purchase'. All measures of a report come from @from; make a second report over 'acme::shop::WorkoutEvent'."});
        expect.put("error-report-from-not-entity", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::DailyRevenue': @from 'StoreTotals' is an object.report; a report aggregates the rows of an object.entity."});
        expect.put("error-report-measure-unresolved", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::DailyRevenue': @measures item 'refunds' names no measure of @from 'acme::shop::Purchase' or of any other entity."});
        expect.put("error-report-segment-unresolved", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::StoreTotals': @segment 'completions' names no segment of @from 'acme::shop::Purchase'."});
        expect.put("error-report-writable-source", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::StoreTotals': source.rdb is writable; a report is read-only, so its source must declare a read-only @kind (view, materializedView, storedProc or tableFunction)."});
        expect.put("error-segment-filter-bad-field", new String[]{"ERR_BAD_ATTR_FILTER",
                "segment 'active' on entity 'acme::shop::Purchase': @filter names 'state', which is not a field of 'acme::shop::Purchase'."});
        // R8 / R9 / M7 / M8 (FR-044 zero rows and measure defaults). error-measure-default-not-integer
        // is not here: this port refuses a fractional @default in the generic attr.int parse, so the
        // load stops before this pass runs (aFractionalMeasureDefaultIsOneBadAttrValueOnTheMeasure).
        expect.put("error-report-spine-to-many", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::ProgramSales': @spine 'Purchase.program.purchases' crosses relationship 'purchases' on 'acme::shop::Program', which is not to-one. A @spine follows only @cardinality: one relationships and identity.reference hops, so each fact row joins at most one row of the spine entity and is never counted twice."});
        expect.put("error-report-spine-not-from", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::ProgramSales': @spine 'Program.catalog' must start at @from 'acme::shop::Purchase'."});
        expect.put("error-report-spine-no-dimensions", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::CatalogSales': @spine 'Purchase.program.catalog' needs at least one dimension. The report's rows are the dimension tuples of 'acme::shop::Catalog'; with no dimension it would be one totals row."});
        expect.put("error-report-spine-dimension-off-spine", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::ProgramSales': dimension 'purchasedAt' is read from @from 'acme::shop::Purchase', so it has no value in a row that has no facts. With @spine 'Purchase.program' every dimension must be reached through it: declare the dimension over a field of 'acme::shop::Program' (or an entity to-one from it) with an @via that begins 'Purchase.program'."});
        expect.put("error-report-spine-dimension-other-path", new String[]{"ERR_INVALID_REPORT",
                "report 'acme::shop::ProgramSales': dimension 'programByRef' is reached by @via 'Purchase.fkProgram', which does not begin with the hops of @spine 'Purchase.program'. Hop names are compared as written: if both name the same join, write the same hops; otherwise the dimension is not reached through the spine."});
        expect.put("error-measure-default-on-count", new String[]{"ERR_INVALID_MEASURE",
                "measure 'purchases' on entity 'acme::shop::Purchase': @default cannot apply to @agg: count. A count is never null (it is 0 when nothing matches); remove @default."});
        expect.put("error-measure-default-non-numeric", new String[]{"ERR_INVALID_MEASURE",
                "measure 'lastPurchaseAt' on entity 'acme::shop::Purchase': @default is a number, but 'Purchase.purchasedAt', the @of of @agg 'max', is a field.timestamp. A default is supported on numeric measures only."});

        List<String> failures = new ArrayList<>();
        for (Map.Entry<String, String[]> e : expect.entrySet()) {
            Path input = corpusRoot().resolve(e.getKey()).resolve("input");
            List<MetaDataSource> sources = new ArrayList<>();
            try (Stream<Path> files = Files.list(input)) {
                for (Path f : files.sorted().collect(Collectors.toList())) {
                    sources.add(new InMemoryStringSource(
                            Files.readString(f, StandardCharsets.UTF_8), f.getFileName().toString()));
                }
            }
            List<MetaDataException> got = ValidationPhase.validateReporting(loadTree(sources));
            if (got.size() != 1) {
                failures.add(e.getKey() + ": expected 1 finding, got " + got.size() + " " + got);
                continue;
            }
            String code = codes(got).get(0);
            String message = got.get(0).getMessage();
            if (!e.getValue()[0].equals(code) || !e.getValue()[1].equals(message)) {
                failures.add(e.getKey() + ":\n  want " + e.getValue()[0] + " " + e.getValue()[1]
                        + "\n  got  " + code + " " + message);
            }
        }
        assertTrue(String.join("\n", failures), failures.isEmpty());
    }

    @Test
    public void positiveFixturesAreClean() throws IOException {
        assertEquals(List.of(), ValidationPhase.validateReporting(loadJson(cleanModel())));
        assertEquals(List.of(), ValidationPhase.validateReporting(loadJson(fixtureDoc("reporting-inherited-members"))));
        assertEquals(List.of(), ValidationPhase.validateReporting(loadJson(fixtureDoc("reporting-spine-and-default"))));
        assertEquals(List.of(), ValidationPhase.validateReporting(loadJson(fixtureDoc("reporting-spine-inherited"))));
    }

    // ---------------------------------------------------------------------------
    // One broken rule = one error
    // ---------------------------------------------------------------------------

    @Test
    public void tupleWithDistinctButSumIsOneM2Error() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "WorkoutEvent", "measure.aggregate", "daysEngaged").addProperty("@agg", "sum");
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_INVALID_MEASURE"), codes(got));
        assertTrue(got.get(0).getMessage(), got.get(0).getMessage().contains("@of lists 4 columns"));
    }

    @Test
    public void unresolvedFromSkipsTheRestOfTheReport() throws IOException {
        JsonObject doc = cleanModel();
        JsonObject report = rootNode(doc, "object.report", "DailyRevenue");
        report.addProperty("@from", "Nowhere");
        report.add("@measures", JsonParser.parseString("[\"nothing\"]"));
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_INVALID_REPORT"), codes(got));
        assertEquals("report 'acme::shop::DailyRevenue': @from 'Nowhere' does not resolve to an object.",
                got.get(0).getMessage());
    }

    @Test
    public void measureListedTwiceIsNamedAsARepeat() throws IOException {
        JsonObject doc = cleanModel();
        rootNode(doc, "object.report", "StoreTotals").add("@measures",
                JsonParser.parseString("[\"purchases\", \"purchases\"]"));
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_INVALID_REPORT"), codes(got));
        assertEquals("report 'acme::shop::StoreTotals': @measures lists 'purchases' more than once.",
                got.get(0).getMessage());
    }

    @Test
    public void attributeDimensionAndMeasureWithOneNameCollide() throws IOException {
        // An attribute dimension derives its bare name, so dimension `revenue` and measure
        // `revenue` would both become report field `revenue` (R6).
        JsonObject doc = cleanModel();
        rootNode(doc, "object.entity", "Purchase").getAsJsonArray("children")
                .add(json("{\"dimension.attribute\":{\"name\":\"revenue\",\"@of\":\"Purchase.status\"}}"));
        rootNode(doc, "object.report", "StoreTotals").add("@dimensions", JsonParser.parseString("[\"revenue\"]"));
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_INVALID_REPORT"), codes(got));
        assertEquals("report 'acme::shop::StoreTotals': dimension item 'revenue' and measure 'revenue' both derive "
                + "report field 'revenue'. Report field names must be unique; rename the measure or drop one item.",
                got.get(0).getMessage());
    }

    // ---------------------------------------------------------------------------
    // Inheritance: a broken base member once; each inheritor that breaks it, once each
    // ---------------------------------------------------------------------------

    private static JsonObject inheritedModel(String... overridingEntities) throws IOException {
        JsonObject doc = fixtureDoc("reporting-inherited-members");
        for (String name : overridingEntities) {
            JsonObject entity = json("{\"name\":\"" + name + "\",\"extends\":\"BaseEvent\",\"children\":["
                    + "{\"source.rdb\":{\"@table\":\"" + name.toLowerCase() + "\"}},"
                    + "{\"field.string\":{\"name\":\"occurredAt\"}},"
                    + "{\"identity.primary\":{\"name\":\"id\",\"@fields\":[\"id\"]}}]}");
            JsonObject wrapper = new JsonObject();
            wrapper.add("object.entity", entity);
            rootChildren(doc).add(wrapper);
        }
        return doc;
    }

    @Test
    public void brokenBaseMemberIsReportedOnce() throws IOException {
        JsonObject doc = fixtureDoc("reporting-inherited-members");
        JsonObject base = rootNode(doc, "object.entity", "BaseEvent");
        for (JsonElement w : base.getAsJsonArray("children")) {
            JsonObject m = w.getAsJsonObject().getAsJsonObject("measure.aggregate");
            if (m != null) m.addProperty("@of", "BaseEvent.missing");
        }
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_INVALID_MEASURE"), codes(got));
        assertEquals("measure 'events' on entity 'acme::shop::BaseEvent': @of 'BaseEvent.missing' names no field "
                + "'missing' on 'acme::shop::BaseEvent'.", got.get(0).getMessage());
    }

    @Test
    public void eachInheritorThatBreaksAnInheritedMemberIsReported() throws IOException {
        List<MetaDataException> got = ValidationPhase.validateReporting(
                loadJson(inheritedModel("LoginEvent", "SignupEvent")));
        assertEquals(List.of("ERR_INVALID_DIMENSION", "ERR_INVALID_DIMENSION"), codes(got));
        String head = "dimension 'occurredAt' on entity 'acme::shop::BaseEvent'";
        String body = ": a time dimension's @of must be a field.date or field.timestamp, but "
                + "'BaseEvent.occurredAt' is field.string.";
        assertEquals(head + " (inherited by 'acme::shop::LoginEvent')" + body, got.get(0).getMessage());
        assertEquals(head + " (inherited by 'acme::shop::SignupEvent')" + body, got.get(1).getMessage());
    }

    // ---------------------------------------------------------------------------
    // The loader's envelope dedupe keeps distinct reporting findings on one node
    // ---------------------------------------------------------------------------

    /** Every error a full load reports: those recorded on the loader plus the one thrown. */
    private static List<MetaDataException> loadErrors(JsonObject doc) {
        MetaDataLoader loader = strictLoader("reporting-validation-load-errors");
        List<MetaDataException> all = new ArrayList<>();
        try {
            loader.load(List.of(new InMemoryStringSource(new Gson().toJson(doc), "meta.shop.json")));
        } catch (MetaDataException thrown) {
            all.addAll(loader.getErrors());
            all.add(thrown);
        }
        return all;
    }

    @Test
    public void twoInheritorsBreakingOneInheritedDimensionAreTwoLoadErrors() throws IOException {
        // Both findings sit on the SAME node (the base's dimension) with the same code;
        // only the message names the inheritor. The loader must not collapse them.
        List<MetaDataException> got = loadErrors(inheritedModel("LoginEvent", "SignupEvent"));
        assertEquals(List.of("ERR_INVALID_DIMENSION", "ERR_INVALID_DIMENSION"), codes(got));
        assertTrue(got.get(0).getMessage(), got.get(0).getMessage().contains("(inherited by 'acme::shop::LoginEvent')"));
        assertTrue(got.get(1).getMessage(), got.get(1).getMessage().contains("(inherited by 'acme::shop::SignupEvent')"));
    }

    @Test
    public void badDimensionItemAndBadSegmentOnOneReportAreTwoLoadErrors() throws IOException {
        JsonObject doc = cleanModel();
        JsonObject report = rootNode(doc, "object.report", "StoreTotals");
        report.add("@dimensions", JsonParser.parseString("[\"region\"]"));
        report.addProperty("@segment", "completions");
        List<MetaDataException> got = loadErrors(doc);
        assertEquals(List.of("ERR_INVALID_REPORT", "ERR_INVALID_REPORT"), codes(got));
        assertEquals("report 'acme::shop::StoreTotals': @dimensions item 'region' names no dimension of @from "
                + "'acme::shop::Purchase'.", got.get(0).getMessage());
        assertEquals("report 'acme::shop::StoreTotals': @segment 'completions' names no segment of @from "
                + "'acme::shop::Purchase'.", got.get(1).getMessage());
    }

    // ---------------------------------------------------------------------------
    // Relative-date values (F1 / F2) and the desugar rule
    // ---------------------------------------------------------------------------

    @Test
    public void explicitOpRelativeValueSurvivesDesugaringUnchanged() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "Purchase", "segment.filter", "active").add("@filter",
                json("{\"purchasedAt\":{\"gte\":{\"now\":\"-P7D\"}}}"));
        MetaRoot root = loadJson(doc);
        assertEquals(List.of(), ValidationPhase.validateReporting(root));
        MetaSegment seg = null;
        for (var o : root.getChildren(com.metaobjects.object.MetaObject.class, false)) {
            if ("Purchase".equals(o.getShortName())) {
                seg = o.getChildren(MetaSegment.class, true).get(0);
            }
        }
        assertNotNull(seg);
        assertEquals(Map.of("purchasedAt", Map.of("gte", Map.of("now", "-P7D"))), seg.getFilter());
    }

    @Test
    public void operatorLessShorthandIsAnImplicitEqAndRefusedAsSuch() throws IOException {
        JsonObject doc = cleanModel();
        rootNode(doc, "object.report", "DailyRevenue").add("@filter",
                json("{\"purchasedAt\":{\"now\":\"-P7D\"}}"));
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_BAD_ATTR_FILTER"), codes(got));
        assertEquals("report 'acme::shop::DailyRevenue': @filter on 'purchasedAt' puts a relative date under "
                + "op 'eq'; relative dates are legal only under gt, gte, lt and lte.", got.get(0).getMessage());
    }

    @Test
    public void malformedRelativeValueIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        rootNode(doc, "object.report", "DailyRevenue").add("@filter",
                json("{\"purchasedAt\":{\"gte\":{\"now\":\"-P7D\",\"x\":1}}}"));
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_BAD_ATTR_FILTER"), codes(got));
        assertEquals("report 'acme::shop::DailyRevenue': @filter on 'purchasedAt' has a malformed relative date "
                + "{\"now\":\"-P7D\",\"x\":1}; a relative date is exactly { now: \"<ISO-8601 duration>\" } with no "
                + "other keys.", got.get(0).getMessage());
    }

    @Test
    public void degenerateDurationIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        rootNode(doc, "object.report", "DailyRevenue").add("@filter",
                json("{\"purchasedAt\":{\"gte\":{\"now\":\"P\"}}}"));
        assertEquals(List.of("ERR_BAD_ATTR_FILTER"), codes(ValidationPhase.validateReporting(loadJson(doc))));
    }

    @Test
    public void aFieldNamedNowIsAFieldNotARelativeDate() throws IOException {
        JsonObject doc = fixtureDoc("error-relative-date-wrong-host");
        JsonObject projection = rootNode(doc, "object.projection", "RecentPurchase");
        // Replace the projection's relative-date filter with one on a field literally named `now`.
        projection.getAsJsonArray("children").add(json("{\"field.timestamp\":{\"name\":\"now\",\"extends\":\"Purchase.purchasedAt\"}}"));
        projection.add("@filter", json("{\"now\":{\"gte\":\"2026-01-01T00:00:00Z\"}}"));
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of(), got);
    }

    // ---------------------------------------------------------------------------
    // Closed sets (Java: .withEnum is decorative, so the pass enforces them)
    // ---------------------------------------------------------------------------

    @Test
    public void aggOutsideTheClosedSetIsABadAttrValue() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "Purchase", "measure.aggregate", "revenue").addProperty("@agg", "median");
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_BAD_ATTR_VALUE"), codes(got));
        // Byte-identical to the TS attr-schema check (attr-schema-validate.ts, Check 3).
        assertEquals("measure.aggregate 'revenue' attribute '@agg' has value 'median' which is not one of "
                + "the allowed values: count, sum, avg, min, max", got.get(0).getMessage());
    }

    @Test
    public void grainOutsideTheClosedSetIsABadAttrValue() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "Purchase", "dimension.time", "purchasedAt").add("@grains",
                JsonParser.parseString("[\"day\", \"fortnight\"]"));
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_BAD_ATTR_VALUE"), codes(got));
        // An isArray attr reports each offending ELEMENT, as TS does.
        assertEquals("dimension.time 'purchasedAt' attribute '@grains' has value 'fortnight' which is not one "
                + "of the allowed values: hour, day, week, month, quarter, year", got.get(0).getMessage());
    }

    // ---------------------------------------------------------------------------
    // A bare-string @of is ONE item — never split on commas (TS stringList)
    // ---------------------------------------------------------------------------

    @Test
    public void aBareStringOfWithACommaIsOneInvalidItem() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "Purchase", "measure.aggregate", "revenue").addProperty("@of", "Purchase.amountCents,Purchase.id");
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(List.of("ERR_INVALID_MEASURE"), codes(got));
        assertEquals("measure 'revenue' on entity 'acme::shop::Purchase': @of 'Purchase.amountCents,Purchase.id' "
                + "must be Entity.field.", got.get(0).getMessage());
    }

    // ---------------------------------------------------------------------------
    // R8 / R9 — a report's @spine (Table B of
    // docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md).
    // The same cases as the TypeScript reporting-validation.test.ts, message for message.
    // ---------------------------------------------------------------------------

    private static JsonObject wrap(String typeKey, String body) {
        JsonObject w = new JsonObject();
        w.add(typeKey, json(body));
        return w;
    }

    private static JsonArray childrenOf(JsonObject doc, String entity) {
        return rootNode(doc, "object.entity", entity).getAsJsonArray("children");
    }

    /** Append report {@code ProgramPurchases} over Purchase with {@code @spine: Purchase.program};
     *  {@code attrs} override (a JSON null deletes). */
    private static void addSpineReport(JsonObject doc, String attrs) {
        JsonObject report = json("{\"name\":\"ProgramPurchases\",\"@from\":\"Purchase\",\"@spine\":\"Purchase.program\","
                + "\"@dimensions\":[\"programTitle\"],\"@measures\":[\"purchases\",\"revenue\"]}");
        for (Map.Entry<String, JsonElement> e : json(attrs).entrySet()) {
            if (e.getValue().isJsonNull()) report.remove(e.getKey());
            else report.add(e.getKey(), e.getValue());
        }
        JsonObject wrapper = new JsonObject();
        wrapper.add("object.report", report);
        rootChildren(doc).add(wrapper);
    }

    /** Program -> Coach -> Agency, both to-one, plus Purchase dimensions at the end of each hop. */
    private static void addCoachChain(JsonObject doc) {
        JsonArray program = childrenOf(doc, "Program");
        program.add(wrap("field.long", "{\"name\":\"coachId\"}"));
        program.add(wrap("identity.reference", "{\"name\":\"coachRef\",\"@references\":\"Coach\",\"@fields\":[\"coachId\"]}"));
        program.add(wrap("relationship.association", "{\"name\":\"coach\",\"@objectRef\":\"Coach\",\"@cardinality\":\"one\"}"));
        rootChildren(doc).add(wrap("object.entity", "{\"name\":\"Coach\",\"children\":["
                + "{\"source.rdb\":{\"@table\":\"coaches\"}},"
                + "{\"field.long\":{\"name\":\"id\"}},"
                + "{\"field.string\":{\"name\":\"name\"}},"
                + "{\"field.long\":{\"name\":\"agencyId\"}},"
                + "{\"identity.primary\":{\"name\":\"id\",\"@fields\":[\"id\"]}},"
                + "{\"identity.reference\":{\"name\":\"agencyRef\",\"@references\":\"Agency\",\"@fields\":[\"agencyId\"]}},"
                + "{\"relationship.association\":{\"name\":\"agency\",\"@objectRef\":\"Agency\",\"@cardinality\":\"one\"}}]}"));
        rootChildren(doc).add(wrap("object.entity", "{\"name\":\"Agency\",\"children\":["
                + "{\"source.rdb\":{\"@table\":\"agencies\"}},"
                + "{\"field.long\":{\"name\":\"id\"}},"
                + "{\"field.string\":{\"name\":\"name\"}},"
                + "{\"identity.primary\":{\"name\":\"id\",\"@fields\":[\"id\"]}}]}"));
        JsonArray purchase = childrenOf(doc, "Purchase");
        purchase.add(wrap("dimension.attribute",
                "{\"name\":\"coachName\",\"@of\":\"Coach.name\",\"@via\":\"Purchase.program.coach\"}"));
        purchase.add(wrap("dimension.attribute",
                "{\"name\":\"agencyName\",\"@of\":\"Agency.name\",\"@via\":\"Purchase.program.coach.agency\"}"));
    }

    /** A dimension of Purchase reaching Program.title through the identity.reference, not the relationship. */
    private static JsonObject programTitleByRef() {
        return wrap("dimension.attribute",
                "{\"name\":\"programTitleByRef\",\"@of\":\"Program.title\",\"@via\":\"Purchase.programRef\"}");
    }

    /** The one finding of the reporting pass over {@code doc}, asserting its code. */
    private static String single(JsonObject doc, String code) {
        List<MetaDataException> got = ValidationPhase.validateReporting(loadJson(doc));
        assertEquals(got.toString(), List.of(code), codes(got));
        return got.get(0).getMessage();
    }

    @Test
    public void spineReportWhoseDimensionsAreAllReachedThroughTheSpineLoadsClean() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{}");
        assertEquals(List.of(), loadErrors(doc));
    }

    @Test
    public void r8ToManySpineHopIsRefusedNamingTheReportAndTheHopsEntity() throws IOException {
        JsonObject doc = cleanModel();
        childrenOf(doc, "Program").add(wrap("measure.aggregate",
                "{\"name\":\"programs\",\"@agg\":\"count\",\"@of\":\"Program.id\"}"));
        rootChildren(doc).add(wrap("object.report", "{\"name\":\"ProgramReach\",\"@from\":\"Program\","
                + "\"@spine\":\"Program.purchases\",\"@measures\":[\"programs\"]}"));
        assertEquals("report 'acme::shop::ProgramReach': @spine 'Program.purchases' crosses relationship 'purchases' on "
                + "'acme::shop::Program', which is not to-one. A @spine follows only @cardinality: one relationships "
                + "and identity.reference hops, so each fact row joins at most one row of the spine entity and is never "
                + "counted twice.", single(doc, "ERR_INVALID_REPORT"));
    }

    @Test
    public void r8SpineWhoseOwnerIsAnotherEntityIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@spine\":\"Program.purchases\"}");
        assertEquals("report 'acme::shop::ProgramPurchases': @spine 'Program.purchases' must start at @from "
                + "'acme::shop::Purchase'.", single(doc, "ERR_INVALID_REPORT"));
    }

    @Test
    public void r8SpineHopThatNamesNothingNamesFromAsTheHopsEntity() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@spine\":\"Purchase.nope\"}");
        assertEquals("report 'acme::shop::ProgramPurchases': @spine 'Purchase.nope' names 'nope', which is not a "
                + "relationship or identity.reference of 'acme::shop::Purchase'.", single(doc, "ERR_INVALID_REPORT"));
    }

    @Test
    public void r8SpineWithNoHopIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@spine\":\"Purchase\"}");
        assertEquals("report 'acme::shop::ProgramPurchases': @spine 'Purchase' must be Owner.hop[.hop...], starting at "
                + "@from 'acme::shop::Purchase'.", single(doc, "ERR_INVALID_REPORT"));
    }

    @Test
    public void d2WordingIsUnchangedByTheWalksWordingArgument() throws IOException {
        String head = "dimension 'programTitle' on entity 'acme::shop::Purchase': ";
        String[][] cases = {
                {"Purchase", head + "@via 'Purchase' must be Owner.hop[.hop...], starting at the owning entity."},
                {"WorkoutEvent.program", head + "@via 'WorkoutEvent.program' must start at the owning entity "
                        + "'acme::shop::Purchase'."},
                {"Purchase.nope", head + "@via 'Purchase.nope' names 'nope', which is not a relationship or "
                        + "identity.reference of 'acme::shop::Purchase'."},
        };
        for (String[] c : cases) {
            JsonObject doc = cleanModel();
            member(doc, "Purchase", "dimension.attribute", "programTitle").addProperty("@via", c[0]);
            assertEquals(c[1], single(doc, "ERR_INVALID_DIMENSION"));
        }
    }

    @Test
    public void r8ErrorSourceIsTheReportNode() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@spine\":\"Purchase.nope\"}");
        List<MetaDataException> got = loadErrors(doc);
        assertEquals(List.of("ERR_INVALID_REPORT"), codes(got));
        String path = String.valueOf(got.get(0).getEnvelope().orElse(null));
        assertTrue(path, path.contains("['object.report']"));
        assertTrue(path, path.endsWith("['object.report'], yamlPosition=null]"));
    }

    @Test
    public void r8FailingSkipsR9() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@spine\":\"Purchase.nope\",\"@dimensions\":[\"purchasedAt:day\"]}");
        assertTrue(single(doc, "ERR_INVALID_REPORT").contains("@spine 'Purchase.nope' names 'nope'"));
    }

    @Test
    public void r8InheritedSpineWithTheAbstractBaseAsOwnerLoadsClean() throws IOException {
        JsonObject doc = fixtureDoc("reporting-inherited-members");
        rootChildren(doc).add(wrap("object.entity", "{\"name\":\"Program\",\"children\":["
                + "{\"source.rdb\":{\"@table\":\"programs\"}},"
                + "{\"field.long\":{\"name\":\"id\"}},"
                + "{\"field.string\":{\"name\":\"title\"}},"
                + "{\"identity.primary\":{\"name\":\"id\",\"@fields\":[\"id\"]}}]}"));
        JsonArray base = childrenOf(doc, "BaseEvent");
        base.add(wrap("field.long", "{\"name\":\"programId\"}"));
        base.add(wrap("identity.reference", "{\"name\":\"programRef\",\"@references\":\"Program\",\"@fields\":[\"programId\"]}"));
        base.add(wrap("relationship.association", "{\"name\":\"program\",\"@objectRef\":\"Program\",\"@cardinality\":\"one\"}"));
        base.add(wrap("dimension.attribute",
                "{\"name\":\"programTitle\",\"@of\":\"Program.title\",\"@via\":\"BaseEvent.program\"}"));
        rootChildren(doc).add(wrap("object.report", "{\"name\":\"ProgramEvents\",\"@from\":\"WorkoutEvent\","
                + "\"@spine\":\"BaseEvent.program\",\"@dimensions\":[\"programTitle\"],\"@measures\":[\"events\"]}"));
        assertEquals(List.of(), loadErrors(doc));
    }

    @Test
    public void r9SpineReportWithNoDimensionsIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@dimensions\":null}");
        assertEquals("report 'acme::shop::ProgramPurchases': @spine 'Purchase.program' needs at least one dimension. The "
                + "report's rows are the dimension tuples of 'acme::shop::Program'; with no dimension it would be one "
                + "totals row.", single(doc, "ERR_INVALID_REPORT"));
    }

    @Test
    public void r9DimensionWithNoViaIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@dimensions\":[\"programTitle\",\"program\"]}");
        assertEquals("report 'acme::shop::ProgramPurchases': dimension 'program' is read from @from 'acme::shop::Purchase', so "
                + "it has no value in a row that has no facts. With @spine 'Purchase.program' every dimension must be "
                + "reached through it: declare the dimension over a field of 'acme::shop::Program' (or an entity to-one "
                + "from it) with an @via that begins 'Purchase.program'.", single(doc, "ERR_INVALID_REPORT"));
    }

    @Test
    public void r9TimeDimensionOverAFactColumnIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@dimensions\":[\"programTitle\",\"purchasedAt:day\"]}");
        assertTrue(single(doc, "ERR_INVALID_REPORT").contains(
                "report 'acme::shop::ProgramPurchases': dimension 'purchasedAt' is read from @from"));
    }

    @Test
    public void r9EachOffendingDimensionIsReportedOnceEvenWhenListedAtTwoGrains() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@dimensions\":[\"program\",\"purchasedAt:day\",\"purchasedAt:week\",\"programTitle\"]}");
        List<MetaDataException> got = loadErrors(doc);
        assertEquals(List.of("ERR_INVALID_REPORT", "ERR_INVALID_REPORT"), codes(got));
        assertTrue(got.get(0).getMessage().contains("dimension 'program' is read from @from"));
        assertTrue(got.get(1).getMessage().contains("dimension 'purchasedAt' is read from @from"));
    }

    @Test
    public void r9DimensionThroughASecondReferenceToTheSameEntityIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        JsonArray purchase = childrenOf(doc, "Purchase");
        purchase.add(wrap("field.long", "{\"name\":\"giftProgramId\"}"));
        purchase.add(wrap("identity.reference",
                "{\"name\":\"giftProgramRef\",\"@references\":\"Program\",\"@fields\":[\"giftProgramId\"]}"));
        purchase.add(programTitleByRef());
        purchase.add(wrap("dimension.attribute",
                "{\"name\":\"giftProgramTitle\",\"@of\":\"Program.title\",\"@via\":\"Purchase.giftProgramRef\"}"));
        addSpineReport(doc, "{\"@spine\":\"Purchase.programRef\",\"@dimensions\":[\"programTitleByRef\",\"giftProgramTitle\"]}");
        assertEquals("report 'acme::shop::ProgramPurchases': dimension 'giftProgramTitle' is reached by @via "
                + "'Purchase.giftProgramRef', which does not begin with the hops of @spine 'Purchase.programRef'. Hop names "
                + "are compared as written: if both name the same join, write the same hops; otherwise the dimension is "
                + "not reached through the spine.", single(doc, "ERR_INVALID_REPORT"));
    }

    @Test
    public void r9DimensionWhoseOwnViaFailsD2IsReportedOnceByD2() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "Purchase", "dimension.attribute", "programTitle").addProperty("@via", "Purchase.programm");
        addSpineReport(doc, "{}");
        assertTrue(single(doc, "ERR_INVALID_DIMENSION").contains("@via 'Purchase.programm' names 'programm'"));
    }

    @Test
    public void r9SameJoinNamedByTheRelationshipInSpineAndTheReferenceInViaIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        childrenOf(doc, "Purchase").add(programTitleByRef());
        addSpineReport(doc, "{\"@spine\":\"Purchase.program\",\"@dimensions\":[\"programTitleByRef\"]}");
        String msg = single(doc, "ERR_INVALID_REPORT");
        assertTrue(msg, msg.contains("dimension 'programTitleByRef' is reached by @via 'Purchase.programRef'"));
        assertTrue(msg, msg.contains("@spine 'Purchase.program'"));
    }

    @Test
    public void r9OwnerSegmentIsNotCompared() throws IOException {
        JsonObject doc = cleanModel();
        addSpineReport(doc, "{\"@spine\":\"acme::shop::Purchase.program\"}");
        assertEquals(List.of(), loadErrors(doc));
    }

    @Test
    public void r9TimeDimensionOverAColumnOfTheSpineEntityIsLegal() throws IOException {
        JsonObject doc = cleanModel();
        childrenOf(doc, "Program").add(wrap("field.timestamp", "{\"name\":\"publishedAt\"}"));
        childrenOf(doc, "Purchase").add(wrap("dimension.time", "{\"name\":\"programPublishedAt\","
                + "\"@of\":\"Program.publishedAt\",\"@via\":\"Purchase.program\",\"@grains\":[\"month\"]}"));
        addSpineReport(doc, "{\"@dimensions\":[\"programTitle\",\"programPublishedAt:month\"]}");
        assertEquals(List.of(), loadErrors(doc));
    }

    @Test
    public void r9TwoHopSpineWithADimensionAtItAndOneBeyondItIsLegal() throws IOException {
        JsonObject doc = cleanModel();
        addCoachChain(doc);
        addSpineReport(doc, "{\"@spine\":\"Purchase.program.coach\",\"@dimensions\":[\"coachName\",\"agencyName\"]}");
        assertEquals(List.of(), loadErrors(doc));
    }

    @Test
    public void r9DimensionThatStopsShortOfATwoHopSpineIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        addCoachChain(doc);
        addSpineReport(doc, "{\"@spine\":\"Purchase.program.coach\",\"@dimensions\":[\"coachName\",\"programTitle\"]}");
        assertTrue(single(doc, "ERR_INVALID_REPORT").contains("dimension 'programTitle' is reached by @via 'Purchase.program'"));
    }

    // ---------------------------------------------------------------------------
    // M7 / M8 — where a measure's @default can apply (Table B)
    // ---------------------------------------------------------------------------

    @Test
    public void m7DefaultOnACountIsRefusedOnTheMeasureNode() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "Purchase", "measure.aggregate", "purchases").addProperty("@default", 0);
        List<MetaDataException> got = loadErrors(doc);
        assertEquals(List.of("ERR_INVALID_MEASURE"), codes(got));
        assertEquals("measure 'purchases' on entity 'acme::shop::Purchase': @default cannot apply to @agg: count. A count is "
                + "never null (it is 0 when nothing matches); remove @default.", got.get(0).getMessage());
        String path = String.valueOf(got.get(0).getEnvelope().orElse(null));
        assertTrue(path, path.contains("['measure.aggregate']"));
    }

    @Test
    public void m7DefaultOnADistinctCountOfATupleIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "WorkoutEvent", "measure.aggregate", "daysEngaged").addProperty("@default", 0);
        String msg = single(doc, "ERR_INVALID_MEASURE");
        assertTrue(msg, msg.contains("measure 'daysEngaged'"));
        assertTrue(msg, msg.contains("@default cannot apply to @agg: count"));
    }

    @Test
    public void m8DefaultOnAMaxOfATimestampIsRefused() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "WorkoutEvent", "measure.aggregate", "lastActivityAt").addProperty("@default", 0);
        assertEquals("measure 'lastActivityAt' on entity 'acme::shop::WorkoutEvent': @default is a number, but "
                + "'WorkoutEvent.occurredAt', the @of of @agg 'max', is a field.timestamp. A default is supported on "
                + "numeric measures only.", single(doc, "ERR_INVALID_MEASURE"));
    }

    /**
     * The TypeScript reference refuses a fractional {@code @default} in its reporting pass with
     * its own text. This port's generic attr.int parse already refuses it: one
     * {@code ERR_BAD_ATTR_VALUE}, on the measure node, and the load stops there (so M7/M8 never
     * run for it). No second, reporting-specific error is added.
     */
    @Test
    public void aFractionalMeasureDefaultIsOneBadAttrValueOnTheMeasure() throws IOException {
        String[][] cases = {
                // fixture or member edit, the measure's type key, the value the message names
                {"Purchase", "revenue", "measure.aggregate", "0.5"},
                {"WorkoutEvent", "avgDaysPerStarter", "measure.ratio", "0.5"},
                {"Purchase", "purchases", "measure.aggregate", "0.5"},         // a count: M7 is skipped
                {"WorkoutEvent", "lastActivityAt", "measure.aggregate", "-1.5"}, // a max of a timestamp: M8 is skipped
        };
        for (String[] c : cases) {
            JsonObject doc = cleanModel();
            member(doc, c[0], c[2], c[1]).add("@default", JsonParser.parseString(c[3]));
            List<MetaDataException> got = loadErrors(doc);
            assertEquals(c[1] + ": " + got, List.of("ERR_BAD_ATTR_VALUE"), codes(got));
            String path = String.valueOf(got.get(0).getEnvelope().orElse(null));
            assertTrue(path, path.contains("['" + c[2] + "']"));
            assertTrue(got.get(0).getMessage(), got.get(0).getMessage().contains("[default]"));
            assertTrue(got.get(0).getMessage(), got.get(0).getMessage().contains(c[3]));
        }
        // The shared fixture: exactly one error, on the measure the expected envelope names.
        Path input = corpusRoot().resolve("error-measure-default-not-integer").resolve("input");
        JsonObject doc = JsonParser.parseString(Files.readString(input.resolve("meta.shop.json"), StandardCharsets.UTF_8))
                .getAsJsonObject();
        List<MetaDataException> got = loadErrors(doc);
        assertEquals(got.toString(), List.of("ERR_BAD_ATTR_VALUE"), codes(got));
        assertTrue(got.get(0).getMessage(), got.get(0).getMessage().contains("[measure:aggregate:revenue]"));
    }

    @Test
    public void aFractionalDefaultOnAMeasureOfAnAbstractBaseIsReportedOnce() throws IOException {
        JsonObject doc = fixtureDoc("reporting-inherited-members");
        JsonArray base = childrenOf(doc, "BaseEvent");
        base.set(3, wrap("measure.aggregate",
                "{\"name\":\"events\",\"@agg\":\"sum\",\"@of\":\"BaseEvent.id\",\"@default\":0.5}"));
        assertEquals(List.of("ERR_BAD_ATTR_VALUE"), codes(loadErrors(doc)));
    }

    @Test
    public void defaultOnASumAnAvgAMinOfAnIntAndARatioIsFine() throws IOException {
        JsonObject doc = cleanModel();
        member(doc, "Purchase", "measure.aggregate", "revenue").addProperty("@default", 0);
        childrenOf(doc, "Purchase").add(wrap("measure.aggregate",
                "{\"name\":\"avgRevenue\",\"@agg\":\"avg\",\"@of\":\"Purchase.amountCents\",\"@default\":0}"));
        childrenOf(doc, "WorkoutEvent").add(wrap("measure.aggregate",
                "{\"name\":\"firstDay\",\"@agg\":\"min\",\"@of\":\"WorkoutEvent.dayNumber\",\"@default\":1}"));
        member(doc, "WorkoutEvent", "measure.ratio", "avgDaysPerStarter").addProperty("@default", 0);
        assertEquals(List.of(), loadErrors(doc));
    }

    @Test
    public void aMeasureThatBreaksM4AndDeclaresDefaultReportsM4Only() throws IOException {
        JsonObject doc = cleanModel();
        JsonObject revenue = member(doc, "Purchase", "measure.aggregate", "revenue");
        revenue.addProperty("@of", "Purchase.status");
        revenue.addProperty("@default", 0);
        String msg = single(doc, "ERR_INVALID_MEASURE");
        assertTrue(msg, msg.contains("field.string"));
        assertFalse(msg, msg.contains("@default"));
    }

    @Test
    public void aMeasureThatBreaksM1AndDeclaresDefaultOnACountReportsM1Only() throws IOException {
        JsonObject doc = cleanModel();
        JsonObject purchases = member(doc, "Purchase", "measure.aggregate", "purchases");
        purchases.addProperty("@of", "Purchase.nope");
        purchases.addProperty("@default", 0);
        String msg = single(doc, "ERR_INVALID_MEASURE");
        assertTrue(msg, msg.contains("names no field 'nope'"));
        assertFalse(msg, msg.contains("@default"));
    }

    @Test
    public void m7OnACountDeclaredOnAnAbstractBaseIsReportedOnce() throws IOException {
        JsonObject doc = fixtureDoc("reporting-inherited-members");
        childrenOf(doc, "BaseEvent").set(3, wrap("measure.aggregate",
                "{\"name\":\"events\",\"@agg\":\"count\",\"@of\":\"BaseEvent.id\",\"@default\":0}"));
        assertTrue(single(doc, "ERR_INVALID_MEASURE").contains("measure 'events' on entity 'acme::shop::BaseEvent'"));
    }
}
