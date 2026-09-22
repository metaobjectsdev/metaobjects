package com.metaobjects.integration.api;

import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedProjectionControllerHarness;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
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
 * F22 — the Java GENERATED-controller lane for the view-only-projection api-contract
 * sub-corpus. Boots the GENERATED Spring {@code InvoiceSummaryController} over an embedded Tomcat
 * behind the read-only in-memory repository seam and drives all seven scenarios.
 *
 * <p>Generated lane ONLY, on purpose and on every port (see the sub-corpus README). What
 * is under test is whether the port's GENERATOR emits routes for a view-only projection
 * at all — Java emitted nothing before this. A hand-rolled reference server would answer
 * every scenario by construction, because writing one IS the decision to serve the
 * projection, and it would prove nothing about the emitted artifact.</p>
 *
 * <p>Run on-demand:
 * {@code mvn -f server/java/integration-tests/pom.xml test -Dtest=ProjectionGeneratedApiContractConformanceTest}</p>
 */
@DisplayName("API contract projection — GENERATED Spring controller (codegen-spring) over embedded Tomcat")
final class ProjectionGeneratedApiContractConformanceTest {

    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(ProjectionCorpus.scenariosDir());
    private static final List<Map<String, Object>> SEED_ROWS = ProjectionCorpus.seedRows();

    private static GeneratedProjectionControllerHarness HARNESS;

    @BeforeAll
    static void setUp() throws Exception {
        Path genDir = Files.createTempDirectory("projection-generated-controllers");
        HARNESS = new GeneratedProjectionControllerHarness(ProjectionCorpus.root(), genDir, SEED_ROWS);
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
                GeneratedProjectionControllerHarness.Response res =
                    HARNESS.exchange(req.method(), req.path(), req.body());
                Object parsed = HARNESS.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }
}
