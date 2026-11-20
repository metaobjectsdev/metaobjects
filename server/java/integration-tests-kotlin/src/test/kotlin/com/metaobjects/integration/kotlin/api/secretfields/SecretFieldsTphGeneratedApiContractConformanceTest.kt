package com.metaobjects.integration.kotlin.api.secretfields

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import com.metaobjects.integration.kotlin.api.tph.generated.GeneratedTphControllerHarness
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
 * #484 — the Kotlin GENERATED-controller lane for a TPH sibling credential: a column one subtype of a
 * single-table hierarchy marks as a credential (`view.password`) is a credential for the whole table,
 * so the base's and both subtypes' filter and sort allowlists leave it out and a request naming it is
 * refused (`invalid_filter_field`, `invalid_sort`).
 *
 * Hosts the generated TPH `AuthController` through the same harness as the `tph/` corpus, over
 * `secret-fields/tph/` (the same table, one shared column marked on one subtype).
 */
@DisplayName("API contract secret-fields TPH sibling credential — GENERATED Kotlin Spring controller over embedded Tomcat")
internal class SecretFieldsTphGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            HARNESS.reset()
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path, req.body)
                val parsed = HARNESS.parseBody(res.body)
                ApiContractAssertions.assertResponse(scenario.name, req, res.status, parsed)
            }
        }
    }

    companion object {
        private val ROOT = ApiContractScenarioLoader.findCorpusRoot().resolve("secret-fields/tph")

        @Suppress("UNCHECKED_CAST")
        private val SEED_ROWS: List<Map<String, Any?>> by lazy {
            val text = Files.readString(ROOT.resolve("seed.json"), StandardCharsets.UTF_8)
            val parsed = ObjectMapper().readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["auths"] as? List<Map<String, Any?>>) ?: error("secret-fields/tph/seed.json: missing 'auths' array")
        }

        private lateinit var HARNESS: GeneratedTphControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val genDir = Files.createTempDirectory("secret-fields-tph-generated-kotlin-controller")
            HARNESS = GeneratedTphControllerHarness(
                ApiContractScenarioLoader.findCorpusRoot(), genDir, SEED_ROWS, ROOT.resolve("meta.json"),
            )
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> =
            ApiContractScenarioLoader.loadScenarios(ROOT.resolve("scenarios")).stream().map { Arguments.of(it.name, it) }
    }
}
