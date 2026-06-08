package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.tph.generated.GeneratedTphControllerHarness;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
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
}
