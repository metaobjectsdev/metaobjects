package com.metaobjects.integration.api.m2m;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.PostgresContainer;
import com.metaobjects.integration.api.m2m.M2mScenarios.M2mRequest;
import com.metaobjects.integration.api.m2m.M2mScenarios.M2mScenario;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

/**
 * FR-018 — cross-port M:N api-contract conformance, Java REFERENCE lane.
 *
 * <p>One JUnit invocation per scenario in
 * {@code fixtures/api-contract-conformance/m2m/scenarios/}. Each spins up a fresh
 * Postgres testcontainer + the hand-rolled {@link M2mReferenceServer} (6 tables
 * seeded from the shared {@code seed.json}), walks the scenario's GET traversal
 * requests, and asserts the related-row {@code name} multiset
 * order-insensitively.</p>
 *
 * <p>The GENERATED-controller lane lives in {@link M2mGeneratedApiContractConformanceTest}.
 * Mirror of {@code M2mApiContractConformanceTest.kt} in {@code integration-tests-kotlin}.</p>
 *
 * <p>Run on-demand:
 * <pre>{@code
 *   mvn -f server/java/integration-tests/pom.xml \
 *     test -Dtest=M2mApiContractConformanceTest
 * }</pre>
 */
@DisplayName("API contract M:N — hand-rolled reference server (Testcontainers Postgres)")
final class M2mApiContractConformanceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path CORPUS = M2mScenarios.findM2mCorpus();
    private static final List<M2mScenario> SCENARIOS =
        M2mScenarios.loadScenarios(CORPUS.resolve("scenarios"));
    private static final Map<String, List<Map<String, Object>>> SEED = M2mSeed.load(CORPUS);

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String name, M2mScenario scenario) {
        assertDoesNotThrow(() -> {
            try (PostgresContainer pg = new PostgresContainer();
                 M2mReferenceServer server = new M2mReferenceServer(pg, SEED)) {
                HttpClient client = HttpClient.newHttpClient();
                for (M2mRequest req : scenario.requests()) {
                    HttpResponse<String> res = client.send(
                        HttpRequest.newBuilder(URI.create(server.baseUrl() + req.path())).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                    Object parsed = (res.body() == null || res.body().isEmpty())
                        ? null
                        : MAPPER.readValue(res.body(), Object.class);
                    M2mScenarios.assertResponse(scenario.name(), req, res.statusCode(), parsed);
                }
            }
        });
    }
}
