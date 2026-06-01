package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedAuthorControllerHarness;
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
 * Cross-port API contract conformance — Java GENERATED-controller lane (SP-F Unit 1).
 *
 * <p>Where the sibling {@link ApiContractConformanceTest} drives a hand-rolled
 * reference server, this lane drives the <strong>generated</strong> Spring
 * {@code @RestController} (emitted by {@code codegen-spring}) over HTTP via
 * {@link GeneratedAuthorControllerHarness} (generate→compile→MockMvc). It proves
 * the deployed Java API artifact — the generated controller — implements the
 * cross-port contract, not just a hand-written stand-in.</p>
 *
 * <p>The generated controller is hosted UNMODIFIED. The only hand-written piece
 * is the in-memory {@code AuthorRepository} impl behind the generated repository
 * interface (the consumer seam MetaObjects intentionally leaves unimplemented);
 * it is test scaffolding, not a conformance subject. Same 20 scenarios, same
 * {@code expect} bytes, same {@link ApiContractAssertions} as every other port's
 * lane.</p>
 *
 * <p>Run on-demand:
 * <pre>{@code
 *   mvn -f server/java/integration-tests/pom.xml \
 *     test -Dtest=ApiContractGeneratedConformanceTest
 * }</pre>
 */
@DisplayName("API contract — GENERATED Spring controller (codegen-spring) over MockMvc")
final class ApiContractGeneratedConformanceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path CORPUS = ApiContractScenarioLoader.findCorpusRoot();
    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(CORPUS.resolve("scenarios"));

    @SuppressWarnings("unchecked")
    private static final List<Map<String, Object>> SEED_ROWS;
    static {
        try {
            String text = Files.readString(CORPUS.resolve("seed.json"), StandardCharsets.UTF_8);
            Map<String, Object> parsed = MAPPER.readValue(text, Map.class);
            Object rows = parsed.get("rows");
            if (!(rows instanceof List<?>))
                throw new IllegalStateException("seed.json: missing 'rows' array");
            SEED_ROWS = (List<Map<String, Object>>) rows;
        } catch (IOException e) {
            throw new RuntimeException("could not load seed.json", e);
        }
    }

    /**
     * The generate→compile→load step is expensive, so the harness is built ONCE
     * per class (the generated artifacts + classloader are reused). Per-scenario
     * isolation comes from {@link GeneratedAuthorControllerHarness#reset(boolean)}
     * rebuilding a freshly-seeded repo + controller + MockMvc.
     */
    private static GeneratedAuthorControllerHarness HARNESS;

    @BeforeAll
    static void setUp() throws Exception {
        Path genDir = Files.createTempDirectory("sp-f-generated-author-controller");
        HARNESS = new GeneratedAuthorControllerHarness(CORPUS, genDir, SEED_ROWS);
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
            HARNESS.reset(!scenario.truncate());
            for (ApiRequest req : scenario.requests()) {
                GeneratedAuthorControllerHarness.Response res =
                    HARNESS.exchange(req.method(), req.path(), req.body());
                Object parsed = HARNESS.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }
}
