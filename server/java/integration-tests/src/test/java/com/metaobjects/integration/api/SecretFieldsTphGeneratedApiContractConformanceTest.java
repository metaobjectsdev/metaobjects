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

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

/**
 * #484 — the Java GENERATED-controller lane for a TPH sibling credential: a column one subtype of a
 * single-table hierarchy marks as a credential ({@code view.password}) is a credential for the whole
 * table, so the base's and both subtypes' filter and sort allowlists leave it out and a request
 * naming it is refused ({@code invalid_filter_field}, {@code invalid_sort}).
 *
 * <p>Hosts the generated TPH {@code AuthController} through the same harness as the {@code tph/}
 * corpus, over {@code secret-fields/tph/} (the same table, one shared column marked on one subtype).</p>
 *
 * <p>Run on-demand:
 * {@code mvn -f server/java/integration-tests/pom.xml test -Dtest=SecretFieldsTphGeneratedApiContractConformanceTest}</p>
 */
@DisplayName("API contract secret-fields TPH sibling credential — GENERATED Spring controller over embedded Tomcat")
final class SecretFieldsTphGeneratedApiContractConformanceTest {

    private static final Path CORPUS = ApiContractScenarioLoader.findCorpusRoot();
    private static final Path ROOT = CORPUS.resolve("secret-fields/tph");
    private static final List<ApiScenario> SCENARIOS = ApiContractScenarioLoader.loadScenarios(ROOT.resolve("scenarios"));

    private static GeneratedTphControllerHarness HARNESS;

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> seedRows() throws Exception {
        String text = Files.readString(ROOT.resolve("seed.json"), StandardCharsets.UTF_8);
        Object rows = new ObjectMapper().readValue(text, Map.class).get("auths");
        if (!(rows instanceof List<?>)) throw new IllegalStateException("secret-fields/tph/seed.json: missing 'auths' array");
        return (List<Map<String, Object>>) rows;
    }

    @BeforeAll
    static void setUp() throws Exception {
        Path genDir = Files.createTempDirectory("secret-fields-tph-generated-controller");
        HARNESS = new GeneratedTphControllerHarness(CORPUS, ROOT.resolve("meta.json"), genDir, seedRows());
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
                GeneratedTphControllerHarness.Response res = HARNESS.exchange(req.method(), req.path(), req.body());
                Object parsed = HARNESS.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }
}
