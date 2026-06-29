package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.PostgresContainer;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

/**
 * Cross-port API contract conformance for the jsonb open-bag corpus
 * ({@code fixtures/api-contract-conformance/jsonb/}) — Java reference lane.
 *
 * <p>One JUnit invocation per scenario: a fresh Postgres testcontainer + the
 * hand-rolled {@link JsonbReferenceServer}, walking the scenario's requests and
 * asserting each response against the cross-port {@code expect.body.*}
 * vocabulary ({@link ApiContractAssertions}). Locks the API-boundary half of the
 * open-bag contract (a posted JSON object reads back PARSED) on the reference
 * server; {@link JsonbGeneratedApiContractConformanceTest} locks it on the
 * GENERATED Spring controller.</p>
 *
 * <p>Run on-demand:
 * {@code mvn -f server/java/integration-tests/pom.xml test -Dtest=JsonbApiContractConformanceTest}</p>
 */
final class JsonbApiContractConformanceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(JsonbCorpus.scenariosDir());
    private static final List<java.util.Map<String, Object>> SEED_ROWS = JsonbCorpus.seedRows();

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String name, ApiScenario scenario) {
        assertDoesNotThrow(() -> {
            try (PostgresContainer pg = new PostgresContainer();
                 JsonbReferenceServer server = new JsonbReferenceServer(pg, SEED_ROWS)) {
                HttpClient client = HttpClient.newHttpClient();
                for (ApiRequest req : scenario.requests()) {
                    HttpRequest.Builder builder =
                        HttpRequest.newBuilder(URI.create(server.baseUrl() + req.path()));
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
                        ? null : MAPPER.readValue(res.body(), Object.class);
                    ApiContractAssertions.assertResponse(scenario.name(), req, res.statusCode(), parsed);
                }
            }
        });
    }
}
