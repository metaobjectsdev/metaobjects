package com.metaobjects.integration.kotlin.api

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.PostgresContainer
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
 * Cross-port API contract conformance — Kotlin reference runner.
 *
 * One JUnit test invocation per scenario in
 * `fixtures/api-contract-conformance/scenarios/`. Each invocation spins up a
 * fresh Postgres testcontainer + an embedded HTTP server (`AuthorApiServer`),
 * walks the scenario's requests, and asserts each response against the
 * cross-port `expect.body.*` vocabulary.
 *
 * Run on-demand:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml \
 *     test -Dtest=ApiContractConformanceTest
 */
internal class ApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            PostgresContainer().use { pg ->
                AuthorApiServer(pg).use { server ->
                    if (scenario.truncate) server.truncate()
                    else server.applySeed(SEED_ROWS)

                    runScenario(server, scenario)
                }
            }
        }
    }

    private fun runScenario(server: AuthorApiServer, scenario: ApiScenario) {
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

    companion object {
        private val MAPPER = ObjectMapper()

        // Loaded once per test class. Each scenario re-applies via applySeed/truncate
        // so the per-scenario isolation contract holds.
        @Suppress("UNCHECKED_CAST")
        private val SEED_ROWS: List<Map<String, Any?>> by lazy {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val seedFile = corpus.resolve("seed.json")
            val text = Files.readString(seedFile, StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["rows"] as? List<Map<String, Any?>>) ?: error("seed.json: missing 'rows' array")
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
