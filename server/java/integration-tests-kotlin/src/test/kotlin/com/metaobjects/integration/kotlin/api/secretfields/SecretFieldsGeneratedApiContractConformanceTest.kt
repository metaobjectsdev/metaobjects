package com.metaobjects.integration.kotlin.api.secretfields

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.PropertyNamingStrategies
import com.fasterxml.jackson.databind.PropertyNamingStrategy
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import com.metaobjects.integration.kotlin.api.secretfields.generated.GeneratedSecretFieldsControllerHarness
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.stream.Stream
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #484 secret-fields api-contract conformance, Kotlin GENERATED-controller lane: a `@formExclude` or
 * credential (`view.password`) field is ignored on every generated write and a credential is never returned.
 */
@DisplayName("API contract secret-fields (#214) — GENERATED Kotlin Spring controller over embedded Tomcat")
internal class SecretFieldsGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            HARNESS.reset() // fresh H2 + seed per scenario (create mutates)
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path, req.body)
                val parsed = HARNESS.parseBody(res.body)
                ApiContractAssertions.assertResponse(scenario.name, req, res.status, parsed)
            }
            assertDeniedColumnsUntouched(scenario.name)
        }
    }

    /**
     * A credential is never returned whatever the host mapper's property naming strategy: under `SNAKE_CASE` the
     * key is `pin_hash`, under `KEBAB_CASE` `pin-hash`, and the generated controller reads that key from the
     * mapper's own contract rather than spelling it `pinHash`. Drives the entity's list and get-by-id and the
     * inheriting projection's.
     */
    @ParameterizedTest(name = "naming={0}")
    @MethodSource("namingStrategies")
    fun `a credential is never returned under any naming strategy`(label: String, naming: PropertyNamingStrategy?) {
        val corpus = ApiContractScenarioLoader.findCorpusRoot()
        val genDir = Files.createTempDirectory("secret-fields-naming-$label")
        GeneratedSecretFieldsControllerHarness(corpus, genDir, SEED, naming).use { harness ->
            harness.reset()
            for (path in listOf("/api/accounts", "/api/accounts/1", "/api/account_views", "/api/account_views/1")) {
                val res = harness.exchange("GET", path, null)
                assertEquals(200, res.status, "$label $path: ${res.body}")
                assertTrue("Ada Lovelace" in res.body, "$label $path: ${res.body}")
                for (secret in listOf("pin-hash-1", "pin-hash-2")) {
                    assertFalse(secret in res.body, "$label $path leaked the credential: ${res.body}")
                }
            }
            // @formExclude alone still returns the field, under the strategy's own key.
            val tokenKey = (naming as? PropertyNamingStrategies.NamingBase)?.translate("tokenHash") ?: "tokenHash"
            val one = harness.exchange("GET", "/api/accounts/1", null).body
            assertTrue("\"$tokenKey\":\"token-hash-1\"" in one, "$label: tokenHash must still be returned as $tokenKey: $one")
        }
    }

    /**
     * The write side of #484, observed on the STORED row (the repository), not on the response: a seeded row's
     * `tokenHash` and `pinHash` are exactly as seeded after every forged create / PATCH / PUT / present-null, and
     * a row the scenario created holds null in both. This is the only place `pinHash`'s write path is observable.
     */
    private fun assertDeniedColumnsUntouched(scenarioName: String) {
        val seeded = SEED.mapIndexed { i, r -> (i + 1).toLong() to r }.toMap()
        for (row in HARNESS.storedRows()) {
            val seed = seeded[row["id"] as Long]
            for (col in listOf("tokenHash", "pinHash")) {
                val expected = seed?.get(col)
                kotlin.test.assertEquals(expected, row[col], "$scenarioName: stored $col of row ${row["id"]}")
            }
        }
    }

    companion object {
        private val MAPPER = ObjectMapper().enable(com.fasterxml.jackson.databind.DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)

        @Suppress("UNCHECKED_CAST")
        private val SEED: List<Map<String, Any?>> by lazy {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val text = Files.readString(corpus.resolve("secret-fields/seed.json"), StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["rows"] as? List<Map<String, Any?>>) ?: error("secret-fields/seed.json: missing 'rows'")
        }

        private lateinit var HARNESS: GeneratedSecretFieldsControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val genDir = Files.createTempDirectory("issue214-generated-kotlin-secret-fields-controller")
            HARNESS = GeneratedSecretFieldsControllerHarness(corpus, genDir, SEED)
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun namingStrategies(): Stream<Arguments> = Stream.of(
            Arguments.of("none", null),
            Arguments.of("snake", PropertyNamingStrategies.SNAKE_CASE),
            Arguments.of("kebab", PropertyNamingStrategies.KEBAB_CASE),
        )

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("secret-fields/scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
