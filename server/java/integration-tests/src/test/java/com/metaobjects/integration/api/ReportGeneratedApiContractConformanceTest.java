package com.metaobjects.integration.api;

import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedReportControllerHarness;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * FR-044 Plan 3 — the Java GENERATED-controller lane for the view-backed-report
 * api-contract sub-corpus. Boots the three GENERATED Spring report controllers on one
 * embedded Tomcat, each behind an in-memory repository seam seeded with what its view
 * returns, and drives all twelve scenarios.
 *
 * <p>Generated lane ONLY, on purpose and on every port (see the sub-corpus README). What
 * is under test is whether the port's GENERATOR emits a read route for a served report,
 * and nothing for a sourceless one. A hand-rolled reference server would answer every
 * scenario by construction.</p>
 *
 * <p>Run on-demand:
 * {@code mvn -f server/java/integration-tests/pom.xml test -Dtest=ReportGeneratedApiContractConformanceTest}</p>
 */
@DisplayName("API contract report — GENERATED Spring controllers (codegen-spring) over embedded Tomcat")
final class ReportGeneratedApiContractConformanceTest {

    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(ReportCorpus.scenariosDir());

    private static GeneratedReportControllerHarness HARNESS;

    @BeforeAll
    static void setUp() throws Exception {
        Map<String, List<Map<String, Object>>> seed = new LinkedHashMap<>();
        for (String report : ReportCorpus.SERVED) seed.put(report, ReportCorpus.seedRows(report));
        Path genDir = Files.createTempDirectory("report-generated-controllers");
        HARNESS = new GeneratedReportControllerHarness(ReportCorpus.root(), genDir, seed, ReportCorpus.SOURCELESS);
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (HARNESS != null) HARNESS.close();
    }

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @Test
    void theCorpusCarriesItsTwelveScenarios() {
        // A scenarios directory that resolved to nothing would leave this lane green and empty.
        assertEquals(12, SCENARIOS.size());
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String name, ApiScenario scenario) {
        assertDoesNotThrow(() -> {
            HARNESS.reset();
            for (ApiRequest req : scenario.requests()) {
                GeneratedReportControllerHarness.Response res =
                    HARNESS.exchange(req.method(), req.path(), req.body());
                Object parsed = HARNESS.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }
}
