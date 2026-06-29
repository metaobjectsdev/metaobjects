package com.metaobjects.integration.api;

import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedJsonbControllerHarness;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

/**
 * #98 — the GENERATED-controller lane for the jsonb open-bag api-contract corpus.
 * Boots the GENERATED Spring {@code DocumentController} (with its {@code Object}
 * payload DTO, #103) over MockMvc behind the in-memory repository seam and drives
 * the same scenarios as {@link JsonbApiContractConformanceTest}. This LOCKS the
 * deployed-controller half of the open-bag contract: a posted JSON object binds
 * to the generated DTO and reads back PARSED, never a JSON-encoded string.
 *
 * <p>Run on-demand:
 * {@code mvn -f server/java/integration-tests/pom.xml test -Dtest=JsonbGeneratedApiContractConformanceTest}</p>
 */
final class JsonbGeneratedApiContractConformanceTest {

    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(JsonbCorpus.scenariosDir());
    private static final List<Map<String, Object>> SEED_ROWS = JsonbCorpus.seedRows();

    private static GeneratedJsonbControllerHarness HARNESS;

    @BeforeAll
    static void setUp() throws Exception {
        Path genDir = Files.createTempDirectory("jsonb-generated-controllers");
        HARNESS = new GeneratedJsonbControllerHarness(JsonbCorpus.root(), genDir, SEED_ROWS);
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
            HARNESS.reset();
            for (ApiRequest req : scenario.requests()) {
                GeneratedJsonbControllerHarness.Response res =
                    HARNESS.exchange(req.method(), req.path(), req.body());
                Object parsed = HARNESS.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }
}
