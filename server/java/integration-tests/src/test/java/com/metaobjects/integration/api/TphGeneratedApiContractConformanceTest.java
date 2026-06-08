package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.tph.generated.GeneratedTphControllerHarness;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

/**
 * FR-017 Tier 4/5 — cross-port TPH polymorphic-CRUD api-contract conformance, Java GENERATED-controller lane.
 *
 * <p>Drives the <strong>generated</strong> Spring {@code AuthController} (the polymorphic collection
 * routes + per-subtype CRUD set emitted by {@code codegen-spring} for the discriminator base) over
 * HTTP via {@link GeneratedTphControllerHarness} (generate→compile→MockMvc). It proves the deployed
 * Java TPH routing artifact — discriminator injection from the URL, subtype-scoped reads/writes, and
 * the cross-subtype 404 — implements the cross-port contract, not just a hand-written stand-in.</p>
 *
 * <p>The generated controller + union {@code AuthDto} + TPH {@code AuthRepository} interface are
 * hosted UNMODIFIED. The only hand-written piece is the in-memory {@code AuthRepository} impl behind
 * the generated interface (the consumer seam); it is test scaffolding, not a conformance subject —
 * the single-table runtime semantics are gated separately by {@code persistence-conformance}'s
 * {@code tph-*} query scenarios. Same 4 scenarios, same {@link ApiContractAssertions} as every other
 * port's TPH lane.</p>
 *
 * <p>Run on-demand:
 * <pre>{@code
 *   mvn -f server/java/integration-tests/pom.xml \
 *     test -Dtest=TphGeneratedApiContractConformanceTest
 * }</pre>
 */
@DisplayName("API contract TPH — GENERATED Spring controller (codegen-spring) over MockMvc")
final class TphGeneratedApiContractConformanceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path CORPUS = ApiContractScenarioLoader.findCorpusRoot();
    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(CORPUS.resolve("tph/scenarios"));

    /** The single TPH table's seed rows (one per subtype), keyed by table name {@code auths}. */
    @SuppressWarnings("unchecked")
    private static final List<Map<String, Object>> SEED_ROWS;
    static {
        try {
            String text = Files.readString(CORPUS.resolve("tph/seed.json"), StandardCharsets.UTF_8);
            Map<String, Object> parsed = MAPPER.readValue(text, Map.class);
            Object rows = parsed.get("auths");
            if (!(rows instanceof List<?>))
                throw new IllegalStateException("tph/seed.json: missing 'auths' array");
            SEED_ROWS = (List<Map<String, Object>>) rows;
        } catch (IOException e) {
            throw new RuntimeException("could not load tph/seed.json", e);
        }
    }

    private static GeneratedTphControllerHarness HARNESS;

    @BeforeAll
    static void setUp() throws Exception {
        Path genDir = Files.createTempDirectory("fr017-generated-tph-controller");
        HARNESS = new GeneratedTphControllerHarness(CORPUS, genDir, SEED_ROWS);
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (HARNESS != null) HARNESS.close();
    }

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String name, ApiScenario scenario) {
        assertDoesNotThrow(() -> {
            HARNESS.reset(); // each TPH scenario mutates the table — fresh seed per scenario
            for (ApiRequest req : scenario.requests()) {
                GeneratedTphControllerHarness.Response res =
                    HARNESS.exchange(req.method(), req.path(), req.body());
                Object parsed = HARNESS.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }

    /**
     * FR-009 filter parity for TPH lists — not covered by the shared corpus (the tph scenarios are
     * sort/length/ids only), so this local smoke exercises the generated filter pipeline the
     * Python/TS lanes also expose: filter the polymorphic list by a subtype column, filter a
     * per-subtype list, and reject an unknown filter field with the cross-port 400 envelope.
     */
    @Test
    @SuppressWarnings("unchecked")
    void tphListsSupportFr009Filters() throws Exception {
        HARNESS.reset(); // seed: Bridge id1 (quantity 5), Copay id2, PriorAuth id3
        // (a) polymorphic list filtered by a SUBTYPE column — only the Bridge row carries quantity.
        var r1 = HARNESS.exchange("GET", "/api/auths?filter[quantity][eq]=5&sort=id:asc", null);
        org.junit.jupiter.api.Assertions.assertEquals(200, r1.status());
        var rows1 = (List<Map<String, Object>>) HARNESS.parseBody(r1.body());
        org.junit.jupiter.api.Assertions.assertEquals(1, rows1.size());
        org.junit.jupiter.api.Assertions.assertEquals(1, ((Number) rows1.get(0).get("id")).intValue());
        // (b) per-subtype list filtered by a base column (discriminator scope AND'd with the predicate).
        var r2 = HARNESS.exchange("GET", "/api/auths/bridge?filter[reference][eq]=REF-1", null);
        org.junit.jupiter.api.Assertions.assertEquals(200, r2.status());
        org.junit.jupiter.api.Assertions.assertEquals(1, ((List<?>) HARNESS.parseBody(r2.body())).size());
        // (c) a no-match filter returns an empty list, not 404.
        var r3 = HARNESS.exchange("GET", "/api/auths/bridge?filter[reference][eq]=NOPE", null);
        org.junit.jupiter.api.Assertions.assertEquals(200, r3.status());
        org.junit.jupiter.api.Assertions.assertEquals(0, ((List<?>) HARNESS.parseBody(r3.body())).size());
        // (d) unknown filter field → 400 invalid_filter_field (cross-port envelope).
        var r4 = HARNESS.exchange("GET", "/api/auths?filter[bogus][eq]=x", null);
        org.junit.jupiter.api.Assertions.assertEquals(400, r4.status());
        org.junit.jupiter.api.Assertions.assertEquals("invalid_filter_field",
            ((Map<String, Object>) HARNESS.parseBody(r4.body())).get("error"));
    }
}
