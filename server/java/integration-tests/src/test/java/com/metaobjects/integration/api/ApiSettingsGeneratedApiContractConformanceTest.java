package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedItemControllerHarness;
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
 * the Java GENERATED-controller lane for the {@code api-settings} api-contract
 * sub-corpus: {@code api.pagination} (a default page size and a hard cap on {@code ?limit=}) and
 * {@code api.unknownFields: drop}, both read from the sub-corpus's own
 * {@code .metaobjects/config.json}.
 *
 * <p>Generated lane ONLY, on every port: what is under test is whether the GENERATOR emits routes
 * that honour the marks, which a hand-rolled reference server would satisfy by construction.</p>
 *
 * <p>Run on-demand:
 * {@code mvn -f server/java/integration-tests/pom.xml test -Dtest=ApiSettingsGeneratedApiContractConformanceTest}</p>
 */
@DisplayName("API contract api-settings — GENERATED Spring controller (codegen-spring) over embedded Tomcat")
final class ApiSettingsGeneratedApiContractConformanceTest {

    private static final Path CONFIG_ROOT = ApiContractScenarioLoader.findCorpusRoot();
    private static final Path ROOT = CONFIG_ROOT.resolve("api-settings");
    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(ROOT.resolve("scenarios"));

    private static GeneratedItemControllerHarness HARNESS;

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> seedRows() throws IOException {
        String text = Files.readString(ROOT.resolve("seed.json"), StandardCharsets.UTF_8);
        Object rows = new ObjectMapper().readValue(text, Map.class).get("rows");
        if (!(rows instanceof List<?>)) throw new IllegalStateException("api-settings/seed.json: missing 'rows' array");
        return (List<Map<String, Object>>) rows;
    }

    @BeforeAll
    static void setUp() throws Exception {
        Path genDir = Files.createTempDirectory("api-settings-generated-controller");
        HARNESS = new GeneratedItemControllerHarness(ROOT, genDir, seedRows());
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
                GeneratedItemControllerHarness.Response res =
                    HARNESS.exchange(req.method(), req.path(), req.body());
                Object parsed = HARNESS.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }

}
