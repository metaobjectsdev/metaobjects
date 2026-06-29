package com.metaobjects.integration.kotlin.api.jsonb

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.PostgresContainer
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.stream.Stream

/**
 * jsonb open-bag api-contract conformance — Kotlin REFERENCE lane (issue #98).
 *
 * One JUnit invocation per scenario in
 * `fixtures/api-contract-conformance/jsonb/scenarios/`. Each spins up a fresh
 * Postgres testcontainer + the hand-rolled [DocumentApiServer], applies the
 * `jsonb/seed.json` rows, walks the scenario's requests, and asserts each response
 * against the shared cross-port `expect.body.*` vocabulary ([ApiContractAssertions];
 * `row` deep-equal + `hasId`) — the structural-equality assertion fails a regressed
 * port that returns a stringified `"{\"k\":\"v\"}"` instead of an object.
 *
 * The GENERATED-controller lane lives in
 * [com.metaobjects.integration.kotlin.api.jsonb.generated.JsonbGeneratedApiContractConformanceTest].
 *
 * Run on-demand:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml test -Dtest=JsonbApiContractConformanceTest
 */
internal class JsonbApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            PostgresContainer().use { pg ->
                DocumentApiServer(pg).use { server ->
                    if (scenario.truncate) server.truncate()
                    else server.applySeed(SEED_ROWS)

                    val client = HttpClient.newHttpClient()
                    for (req in scenario.requests) {
                        val builder = HttpRequest.newBuilder(URI.create(server.baseUrl + req.path))
                        val bodyPublisher = if (req.body != null) {
                            builder.header("Content-Type", "application/json")
                            HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(req.body))
                        } else {
                            HttpRequest.BodyPublishers.noBody()
                        }
                        when (req.method) {
                            "GET" -> builder.GET()
                            "DELETE" -> builder.DELETE()
                            else -> builder.method(req.method, bodyPublisher)
                        }
                        val res = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
                        val parsed: Any? = if (res.body().isNullOrEmpty()) null
                        else MAPPER.readValue(res.body(), Any::class.java)
                        ApiContractAssertions.assertResponse(scenario.name, req, res.statusCode(), parsed)
                    }
                }
            }
        }
    }

    companion object {
        private val MAPPER = ObjectMapper()

        /** The `jsonb/` sub-corpus root (a sibling of the base single-entity corpus). */
        private val CORPUS = ApiContractScenarioLoader.findCorpusRoot().resolve("jsonb")

        @Suppress("UNCHECKED_CAST")
        private val SEED_ROWS: List<Map<String, Any?>> by lazy {
            val text = Files.readString(CORPUS.resolve("seed.json"), StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["rows"] as? List<Map<String, Any?>>) ?: error("jsonb/seed.json: missing 'rows' array")
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> =
            ApiContractScenarioLoader.loadScenarios(CORPUS.resolve("scenarios")).stream()
                .map { Arguments.of(it.name, it) }
    }
}
