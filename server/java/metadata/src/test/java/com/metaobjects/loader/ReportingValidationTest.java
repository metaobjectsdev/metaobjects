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
                "measure 'daysEngaged' on entity 'acme::shop::WorkoutEvent': @of lists 3 columns; a tuple is legal only with @agg: count and @distinct: true (a distinct count of the tuple)."});
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
                "report 'acme::shop::StoreTotals': source.rdb is writable; a report is read-only, so its source must declare @kind: view."});
        expect.put("error-segment-filter-bad-field", new String[]{"ERR_BAD_ATTR_FILTER",
                "segment 'active' on entity 'acme::shop::Purchase': @filter names 'state', which is not a field of 'acme::shop::Purchase'."});

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
        assertTrue(got.get(0).getMessage(), got.get(0).getMessage().contains("@of lists 3 columns"));
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
}
