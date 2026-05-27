package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.PostgresContainer;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

/**
 * Cross-port API contract conformance — Java reference runner.
 *
 * <p>One JUnit test invocation per scenario in
 * {@code fixtures/api-contract-conformance/scenarios/}. Each invocation
 * spins up a fresh Postgres testcontainer + an embedded HTTP server
 * ({@link AuthorApiServer}), walks the scenario's requests, and asserts
 * each response against the cross-port {@code expect.body.*} vocabulary.
 *
 * <p>Mirror of {@code ApiContractConformanceTest.kt} in
 * {@code integration-tests-kotlin}. Hand-rolled JDBC + JDK {@code HttpServer}
 * keep Spring Boot out of this test module's classpath.</p>
 *
 * <p>Run on-demand:
 * <pre>{@code
 *   mvn -f server/java/integration-tests/pom.xml \
 *     test -Dtest=ApiContractConformanceTest
 * }</pre>
 */
final class ApiContractConformanceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path CORPUS = ApiContractScenarioLoader.findCorpusRoot();
    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(CORPUS.resolve("scenarios"));

    /**
     * Loaded once per test class. Each scenario re-applies via
     * applySeed/truncate so the per-scenario isolation contract holds.
     */
    @SuppressWarnings("unchecked")
    private static final List<Map<String, Object>> SEED_ROWS;
    static {
        try {
            Path seedFile = CORPUS.resolve("seed.json");
            String text = Files.readString(seedFile, StandardCharsets.UTF_8);
            Map<String, Object> parsed = MAPPER.readValue(text, Map.class);
            Object rows = parsed.get("rows");
            if (!(rows instanceof List<?>))
                throw new IllegalStateException("seed.json: missing 'rows' array");
            SEED_ROWS = (List<Map<String, Object>>) rows;
        } catch (IOException e) {
            throw new RuntimeException("could not load seed.json", e);
        }
    }

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String name, ApiScenario scenario) {
        assertDoesNotThrow(() -> {
            try (PostgresContainer pg = new PostgresContainer();
                 AuthorApiServer server = new AuthorApiServer(pg)) {
                if (scenario.truncate()) server.truncate();
                else server.applySeed(SEED_ROWS);

                runScenario(server, scenario);
            }
        });
    }

    private void runScenario(AuthorApiServer server, ApiScenario scenario) throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        for (ApiRequest req : scenario.requests()) {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(server.baseUrl() + req.path()));
            HttpRequest.BodyPublisher publisher;
            if (req.body() != null) {
                builder.header("Content-Type", "application/json");
                publisher = HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(req.body()));
            } else {
                publisher = HttpRequest.BodyPublishers.noBody();
            }
            switch (req.method()) {
                case "GET" -> builder.GET();
                case "DELETE" -> builder.DELETE();
                default -> builder.method(req.method(), publisher);
            }
            HttpResponse<String> res = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            Object parsed = (res.body() == null || res.body().isEmpty())
                ? null
                : MAPPER.readValue(res.body(), Object.class);
            ApiContractAssertions.assertResponse(scenario.name(), req, res.statusCode(), parsed);
        }
    }
}
