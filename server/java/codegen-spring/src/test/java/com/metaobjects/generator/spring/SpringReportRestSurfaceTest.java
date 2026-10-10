package com.metaobjects.generator.spring;

import com.metaobjects.MetaDataException;
import com.metaobjects.generator.apidocs.ApiSymbol;
import com.metaobjects.generator.apidocs.ApiSymbolKind;
import com.metaobjects.generator.apidocs.ApiUnit;
import com.metaobjects.generator.apidocs.JavaApiModelBuilder;
import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.reporting.ReportReadModel;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR-044 Plan 3 — a VIEW-BACKED {@code object.report} gets the read-only Spring surface,
 * generated from its read model ({@link ReportReadModel}): the wire DTO, a repository seam
 * with {@code list} and {@code count}, the filter allowlist and a controller that serves
 * the list and refuses the collection {@code POST}. A report has no identity, so there is
 * no {@code /{id}} route and no {@code findById}. A sourceless report stays inert.
 *
 * <p>The model is the shared {@code fixtures/codegen-noop/reporting/with} corpus:
 * {@code StoreTotals} declares a view; {@code DailyRevenue} and {@code ProgramEngagement}
 * declare no source.</p>
 */
public class SpringReportRestSurfaceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String PKG = "acme::shop::";

    private static String withModel() throws Exception {
        Path model = SpringTestFixtures.findCorpusRoot().getParent()
            .resolve("codegen-noop/reporting/with/meta.shop.json");
        return Files.readString(model, StandardCharsets.UTF_8);
    }

    private MetaDataLoader load(String label, String json) throws Exception {
        return SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "report-" + label, json);
    }

    private static List<com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>> surface() {
        return List.of(
            new SpringDtoGenerator(),
            new SpringRepositoryGenerator(),
            new SpringControllerGenerator(),
            new SpringFilterAllowlistGenerator());
    }

    private Path generateAll(String label, String json) throws Exception {
        Path gen = tmp.newFolder().toPath();
        MetaDataLoader loader = load(label, json);
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        for (com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> g : surface()) {
            g.setArgs(args);
            g.execute(loader);
        }
        return gen;
    }

    private static List<String> filesNamed(Path gen, String prefix) throws Exception {
        try (Stream<Path> s = Files.walk(gen)) {
            return s.filter(Files::isRegularFile)
                .map(p -> p.getFileName().toString())
                .filter(n -> n.startsWith(prefix))
                .sorted()
                .collect(Collectors.toList());
        }
    }

    private static int occurrences(String haystack, String needle) {
        int n = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length())) n++;
        return n;
    }

    // === the gate (Table A) ==================================================

    @Test
    public void onlyAViewBackedReportIsServed() throws Exception {
        MetaDataLoader loader = load("gate", withModel());
        MetaObject totals = loader.getMetaObjectByName(PKG + "StoreTotals");
        MetaObject daily = loader.getMetaObjectByName(PKG + "DailyRevenue");
        MetaObject purchase = loader.getMetaObjectByName(PKG + "Purchase");

        assertTrue("a report over a view is served", RestSurfaceGate.isServedReport(totals));
        assertFalse("a sourceless report is not", RestSurfaceGate.isServedReport(daily));
        assertFalse("an entity is not a report", RestSurfaceGate.isServedReport(purchase));

        MetaObject shape = RestSurfaceGate.restShapeOf(totals);
        assertTrue("a served report is generated from its read model", shape instanceof ReportReadModel);
        assertTrue("the read model is itself a served report", RestSurfaceGate.isServedReport(shape));
        assertSame("a read model is its own shape", shape, RestSurfaceGate.restShapeOf(shape));
        assertNull("a sourceless report has no shape", RestSurfaceGate.restShapeOf(daily));
        assertSame("any other object is its own shape", purchase, RestSurfaceGate.restShapeOf(purchase));

        assertTrue("the declared report is read-only", RestSurfaceGate.isReadOnly(totals));
        assertTrue("and so is its read model", RestSurfaceGate.isReadOnly(shape));
        assertFalse("a sourceless report has no surface at all", RestSurfaceGate.emitsRestSurface(daily));
        assertFalse("a report has no identity, so no item route", RestSurfaceGate.hasItemRoute(shape));
    }

    @Test
    public void aReportOverAnyOtherReadOnlyKindIsNotServed() throws Exception {
        // Table A: the lowering skips these kinds, so no relation with the derived columns
        // is promised.
        String json = """
            { "metadata.root": { "package": "acme::shop", "children": [
              { "object.entity": { "name": "Sale", "children": [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
              ] } },
              { "object.report": { "name": "Materialized", "@from": "Sale", "@measures": ["sales"], "children": [
                { "source.rdb": { "@kind": "materializedView", "@materializedView": "mv_sales" } }
              ] } }
            ] } }
            """;
        MetaDataLoader loader = load("mv", json);
        MetaObject report = loader.getMetaObjectByName(PKG + "Materialized");
        assertFalse(RestSurfaceGate.isServedReport(report));
        assertNull(RestSurfaceGate.restShapeOf(report));
        assertFalse(RestSurfaceGate.emitsRestSurface(report));
        assertEquals(List.of(), filesNamed(generateAll("mv-gen", json), "Materialized"));
    }

    @Test
    public void controllerRepositoryAndAllowlistAgreeOnEveryObjectAndEveryShape() throws Exception {
        MetaDataLoader loader = load("lockstep", withModel());
        List<MetaObject> objects = new ArrayList<>(loader.getMetaObjects());
        objects.add(RestSurfaceGate.restShapeOf(loader.getMetaObjectByName(PKG + "StoreTotals")));
        for (MetaObject obj : objects) {
            boolean controller = SpringControllerGenerator.appliesTo(obj);
            assertEquals(obj.getName() + ": repository must agree with controller",
                    controller, SpringRepositoryGenerator.appliesTo(obj));
            assertEquals(obj.getName() + ": filter allowlist must agree with controller",
                    controller, SpringFilterAllowlistGenerator.appliesTo(obj));
        }
    }

    // === what is emitted (Table E) ===========================================

    @Test
    public void aServedReportEmitsExactlyItsFourFilesAndASourcelessOneNothing() throws Exception {
        Path gen = generateAll("files", withModel());
        assertEquals(
            List.of("StoreTotalsController.java", "StoreTotalsDto.java",
                    "StoreTotalsFilterAllowlist.java", "StoreTotalsRepository.java"),
            filesNamed(gen, "StoreTotals"));
        assertEquals(List.of(), filesNamed(gen, "DailyRevenue"));
        assertEquals(List.of(), filesNamed(gen, "ProgramEngagement"));
    }

    @Test
    public void theDtoIsOneComponentPerDerivedFieldAndIsNotConstructable() throws Exception {
        String src = Files.readString(generateAll("dto", withModel()).resolve("acme/shop/StoreTotalsDto.java"));
        assertTrue(src, src.contains("public record StoreTotalsDto("));
        assertTrue("a count is a required long", src.contains("@NotNull Long purchases"));
        assertTrue(src.contains("Long buyers"));
        assertTrue("a sum of currency is integer minor units, nullable", src.contains("Long revenue"));
        assertFalse("a scoped sum is nullable", src.contains("@NotNull Long revenue"));
        // A report row arrives from a query; nothing constructs one (the projection rule).
        assertFalse("no builder", src.contains("builder()"));
    }

    /**
     * A derived enum field (an attribute dimension over a {@code field.enum}) is typed by an
     * enum NESTED IN THE REPORT'S OWN DTO, named {@code <Report><Field>}, in the report's
     * package. It does not reuse the {@code @of} entity's enum type: the read model carries
     * the members ({@code @values}) and no {@code extends}, so the row DTO stays
     * self-contained whatever package the {@code @of} entity lives in.
     */
    @Test
    public void aDerivedEnumFieldIsTypedByAnEnumNestedInTheReportsOwnDto() throws Exception {
        String fitness = Files.readString(
            SpringTestFixtures.findCorpusRoot().resolve("canonical/meta.fitness.json"), StandardCharsets.UTF_8);
        Path gen = generateAll("enum", fitness);
        Path dto;
        try (Stream<Path> s = Files.walk(gen)) {
            dto = s.filter(p -> p.getFileName().toString().equals("ProgramsByMonthDto.java")).findFirst().orElseThrow();
        }
        String src = Files.readString(dto);
        assertTrue(src, src.contains("ProgramsByMonthStatus status"));
        assertTrue(src, src.contains("public enum ProgramsByMonthStatus {"));
        assertTrue("a time dimension at a date grain is a LocalDate", src.contains("java.time.LocalDate createdAtMonth"));
    }

    /**
     * Table F of {@code docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md}
     * (the Java row): no generator is edited; the shape's {@code required} (Table C) reaches
     * the DTO as the same {@code @NotNull} a count carries. {@code ProgramRoster} declares
     * {@code @spine: "Week.fkProgram"}; {@code totalMinutesOrZero} / {@code longShareOrZero}
     * are {@code totalMinutes} / {@code longShare} with {@code @default: 0}.
     */
    @Test
    public void aSpineKeyAndADefaultedMeasureAreNotNullAndTheSameMeasureWithoutADefaultIsNullable() throws Exception {
        String fitness = Files.readString(
            SpringTestFixtures.findCorpusRoot().resolve("canonical/meta.fitness.json"), StandardCharsets.UTF_8);
        Path gen = generateAll("spine", fitness);
        Path dto;
        try (Stream<Path> s = Files.walk(gen)) {
            dto = s.filter(p -> p.getFileName().toString().equals("ProgramRosterDto.java")).findFirst().orElseThrow();
        }
        String src = Files.readString(dto);
        assertTrue("the spine entity's key", src.contains("@NotNull Long programKey"));
        assertTrue("a @required column of the spine entity",
            src.contains("@NotNull @Size(min = 1, max = 200) String programTitle"));
        assertTrue("a count, as before", src.contains("@NotNull Long weeks"));
        assertTrue("a sum with @default", src.contains("@NotNull Long totalMinutesOrZero"));
        assertTrue("a ratio with @default", src.contains("@NotNull java.math.BigDecimal longShareOrZero"));
        assertTrue(src, src.contains("    Long totalMinutes,"));
        assertFalse("the same sum without @default stays nullable", src.contains("@NotNull Long totalMinutes,"));
        assertTrue(src, src.contains("    java.math.BigDecimal longShare,"));
        assertFalse("the same ratio without @default stays nullable",
            src.contains("@NotNull java.math.BigDecimal longShare,"));
    }

    @Test
    public void theRepositoryListsAndCountsAndHasNoIdentity() throws Exception {
        String src = Files.readString(generateAll("seam", withModel()).resolve("acme/shop/StoreTotalsRepository.java"));
        assertTrue(src.contains("List<StoreTotalsDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);"));
        assertTrue(src.contains("long count(List<FilterPredicate> filters);"));
        assertFalse("no findById", src.contains("findById"));
        assertFalse("no Optional import either", src.contains("Optional"));
        assertFalse(src.contains(" create("));
        assertFalse(src.contains(" update("));
        assertFalse(src.contains(" patch("));
        assertFalse(src.contains(" delete("));
        assertTrue("it says what it is", src.contains("is a report over a database view"));
        assertFalse(src.contains("projection"));
    }

    @Test
    public void theAllowlistIsEveryDerivedFieldWithItsSubtypeBand() throws Exception {
        String src = Files.readString(
            generateAll("allowlist", withModel()).resolve("acme/shop/StoreTotalsFilterAllowlist.java"));
        assertTrue(src, src.contains("FIELDS = Set.of(\"purchases\", \"buyers\", \"revenue\");"));
        assertTrue("a measure takes the numeric band",
            src.contains("\"purchases\", Set.of(\"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\")"));
    }

    @Test
    public void theControllerServesTheListAndRefusesOnlyTheCollectionPost() throws Exception {
        // The generated-controller api-contract corpus proves the HTTP behavior (GET list,
        // POST 405, no /{id}); this pins the source-level shape that produces it.
        String src = Files.readString(generateAll("controller", withModel()).resolve("acme/shop/StoreTotalsController.java"));
        assertTrue("the segment is the report name, snake_cased and pluralized",
            src.contains("@RequestMapping(\"/api/store_totals\")"));
        assertEquals("one GET", 1, occurrences(src, "@GetMapping"));
        assertEquals("one POST", 1, occurrences(src, "@PostMapping"));
        assertFalse("no item route of any verb", src.contains("/{id}"));
        assertFalse("nothing calls a report a projection", src.contains("projection"));
        assertTrue("every derived field is sortable",
            src.contains("SORT_ALLOWLIST = Set.of(\"purchases\", \"buyers\", \"revenue\");"));
    }

    // === the refusal carried over from Plan 2 ================================

    @Test
    public void aServedReportOverAFieldObjectStopsEveryGeneratorNamingTheReport() throws Exception {
        String json = """
            { "metadata.root": { "package": "acme::shop", "children": [
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
        MetaDataLoader loader = load("object-dim", json);
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", tmp.newFolder().toString());
        for (com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> g : surface()) {
            g.setArgs(args);
            try {
                g.execute(loader);
                fail(g.getClass().getSimpleName() + " must refuse a served report over a field.object");
            } catch (MetaDataException e) {
                assertTrue(g.getClass().getSimpleName() + ": " + e.getMessage(),
                    e.getMessage().startsWith("report 'SalesByDestination': dimension 'destination'"));
            }
        }
    }

    // === api docs (Table G) ==================================================

    @Test
    public void apiDocsDocumentAServedReportAndNothingForASourcelessOne() throws Exception {
        List<ApiUnit> units = new JavaApiModelBuilder().build(load("docs", withModel()), "shop").units();
        List<String> names = units.stream().map(ApiUnit::node).collect(Collectors.toList());
        assertTrue(names.toString(), names.contains("StoreTotals"));
        assertFalse(names.contains("DailyRevenue"));
        assertFalse(names.contains("ProgramEngagement"));

        ApiUnit totals = units.stream().filter(u -> u.node().equals("StoreTotals")).findFirst().orElseThrow();
        assertEquals("report", totals.kind());
        Map<ApiSymbolKind, List<String>> byKind = new HashMap<>();
        for (ApiSymbol s : totals.symbols()) {
            byKind.computeIfAbsent(s.kind(), k -> new ArrayList<>()).add(s.name());
        }
        assertEquals("the row model", List.of("StoreTotalsDto"), byKind.get(ApiSymbolKind.DTO));
        assertEquals("GET the served path and nothing else",
            List.of("GET /api/store_totals"), byKind.get(ApiSymbolKind.REST));
        assertEquals(List.of("StoreTotalsRepository"), byKind.get(ApiSymbolKind.DATA_ACCESS));
        assertEquals(List.of("StoreTotalsFilterAllowlist"), byKind.get(ApiSymbolKind.FILTER));
        assertNull("no in-memory model class is generated for a report", byKind.get(ApiSymbolKind.MODEL));
        assertNull("a report is never a create or update body", byKind.get(ApiSymbolKind.VALIDATION));

        ApiSymbol repo = totals.symbols().stream()
            .filter(s -> s.kind() == ApiSymbolKind.DATA_ACCESS).findFirst().orElseThrow();
        assertFalse("no findById in the documented seam", repo.signature().contains("findById"));
        ApiSymbol dto = totals.symbols().stream()
            .filter(s -> s.kind() == ApiSymbolKind.DTO).findFirst().orElseThrow();
        assertEquals("one documented field per derived field", 3, dto.fields().size());
    }
}
