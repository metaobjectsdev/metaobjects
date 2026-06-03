package com.metaobjects.integration.api.m2m;

import com.metaobjects.integration.api.m2m.M2mScenarios.M2mRequest;
import com.metaobjects.integration.api.m2m.M2mScenarios.M2mScenario;
import com.metaobjects.integration.api.m2m.generated.GeneratedM2mControllerHarness;
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
 * FR-018 — cross-port M:N api-contract conformance, Java GENERATED-controller lane.
 *
 * <p>Where {@link M2mApiContractConformanceTest} drives a hand-rolled reference
 * server, this lane drives the <strong>generated</strong> Spring
 * {@code @RestController}s ({@code PostController}/{@code PersonController}, emitted
 * by {@code codegen-spring}) over HTTP via {@link GeneratedM2mControllerHarness}
 * (generate→compile→MockMvc). It proves the deployed Java M:N traversal artifact —
 * the generated {@code GET /{id}/<relation>} sub-resources — implements the
 * cross-port contract, not just a hand-written stand-in.</p>
 *
 * <p>The generated controllers are hosted UNMODIFIED. The only hand-written piece
 * is the in-memory repository impl behind each generated repository interface (the
 * consumer seam); it traverses the junction via the runtime {@code M2mJoinResolver}
 * and is test scaffolding, not a conformance subject (real DB traversal is gated by
 * persistence-conformance). Same 3 scenarios, same assertions as the reference lane
 * and every other port.</p>
 *
 * <p>Run on-demand:
 * <pre>{@code
 *   mvn -f server/java/integration-tests/pom.xml \
 *     test -Dtest=M2mGeneratedApiContractConformanceTest
 * }</pre>
 */
@DisplayName("API contract M:N — GENERATED Spring controllers (codegen-spring) over MockMvc")
final class M2mGeneratedApiContractConformanceTest {

    private static final Path CORPUS = M2mScenarios.findM2mCorpus();
    private static final List<M2mScenario> SCENARIOS =
        M2mScenarios.loadScenarios(CORPUS.resolve("scenarios"));
    private static final Map<String, List<Map<String, Object>>> SEED = M2mSeed.load(CORPUS);

    private static GeneratedM2mControllerHarness HARNESS;

    @BeforeAll
    static void setUp() throws Exception {
        Path genDir = Files.createTempDirectory("fr018-generated-m2m-controllers");
        HARNESS = new GeneratedM2mControllerHarness(CORPUS, genDir, SEED);
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
    void scenario(String name, M2mScenario scenario) {
        assertDoesNotThrow(() -> {
            HARNESS.reset();
            for (M2mRequest req : scenario.requests()) {
                GeneratedM2mControllerHarness.Response res = HARNESS.exchange(req.method(), req.path());
                Object parsed = HARNESS.parseBody(res.body());
                M2mScenarios.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }
}
