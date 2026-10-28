package com.metaobjects.integration.kotlin.api.secretfields

import com.fasterxml.jackson.databind.ObjectMapper
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
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("secret-fields/scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
