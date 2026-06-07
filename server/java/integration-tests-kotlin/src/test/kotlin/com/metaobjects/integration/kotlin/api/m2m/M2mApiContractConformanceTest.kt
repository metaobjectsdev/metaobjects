package com.metaobjects.integration.kotlin.api.m2m

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.PostgresContainer
import com.metaobjects.integration.kotlin.api.m2m.M2mScenarios.M2mScenario
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.stream.Stream

/**
 * FR-018 — cross-port M:N api-contract conformance, Kotlin REFERENCE lane.
 *
 * One JUnit invocation per scenario in
 * `fixtures/api-contract-conformance/m2m/scenarios/`. Each spins up a fresh
 * Postgres testcontainer + the hand-rolled [M2mReferenceServer] (6 tables seeded
 * from the shared `seed.json`), walks the scenario's GET traversal requests, and
 * asserts the related-row `name` multiset order-insensitively.
 *
 * The GENERATED-controller lane lives in [com.metaobjects.integration.kotlin.api.m2m.generated.M2mGeneratedApiContractConformanceTest].
 *
 * Run on-demand:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml test -Dtest=M2mApiContractConformanceTest
 */
internal class M2mApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: M2mScenario) {
        assertDoesNotThrow {
            PostgresContainer().use { pg ->
                M2mReferenceServer(pg, SEED).use { server ->
                    val client = HttpClient.newHttpClient()
                    for (req in scenario.requests) {
                        val res = client.send(
                            HttpRequest.newBuilder(URI.create(server.baseUrl + req.path)).GET().build(),
                            HttpResponse.BodyHandlers.ofString())
                        val parsed: Any? = if (res.body().isNullOrEmpty()) null
                        else MAPPER.readValue(res.body(), Any::class.java)
                        M2mScenarios.assertResponse(scenario.name, req, res.statusCode(), parsed)
                    }
                }
            }
        }
    }

    companion object {
        private val MAPPER = ObjectMapper()
        private val CORPUS = M2mScenarios.findM2mCorpus()
        private val SEED = M2mSeed.load(CORPUS)

        @JvmStatic
        fun scenarios(): Stream<Arguments> =
            M2mScenarios.loadScenarios(CORPUS.resolve("scenarios")).stream()
                .map { Arguments.of(it.name, it) }
    }
}
