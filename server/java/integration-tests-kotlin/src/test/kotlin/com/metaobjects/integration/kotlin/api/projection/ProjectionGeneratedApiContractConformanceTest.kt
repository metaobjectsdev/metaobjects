package com.metaobjects.integration.kotlin.api.projection

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import com.metaobjects.integration.kotlin.api.projection.generated.GeneratedProjectionControllerHarness
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
 * F22 — the Kotlin GENERATED-controller lane for the view-only-projection api-contract
 * sub-corpus. Drives the generated read-only `InvoiceSummaryController` over MockMvc:
 * GET list + GET by id with the FR-009 filter and sort allowlists, and every write verb
 * answering `405 {"error": "method_not_allowed"}`.
 *
 * Generated lane ONLY, on purpose and on every port (see the sub-corpus README). What is
 * under test is whether the port's GENERATOR emits routes for a view-only projection at
 * all — Kotlin emitted nothing before this. A hand-rolled reference controller would answer
 * every scenario by construction, because writing one IS the decision to serve the
 * projection, and it would prove nothing about the emitted artifact.
 */
@DisplayName("API contract projection (F22) — GENERATED Kotlin Spring controller over MockMvc")
internal class ProjectionGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            HARNESS.reset() // fresh H2 + view + seed per scenario
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path, req.body)
                val parsed = HARNESS.parseBody(res.body)
                ApiContractAssertions.assertResponse(scenario.name, req, res.status, parsed)
            }
        }
    }

    companion object {
        private val MAPPER = ObjectMapper()

        /**
         * The seed is keyed by the base TABLE (`invoices`) and never by the view: the view
         * derives, which is the whole point of the sub-corpus.
         */
        @Suppress("UNCHECKED_CAST")
        private val SEED: List<Map<String, Any?>> by lazy {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val text = Files.readString(corpus.resolve("projection/seed.json"), StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["invoices"] as? List<Map<String, Any?>>)
                ?: error("projection/seed.json: missing 'invoices'")
        }

        private lateinit var HARNESS: GeneratedProjectionControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val genDir = Files.createTempDirectory("f22-generated-kotlin-projection-controller")
            HARNESS = GeneratedProjectionControllerHarness(corpus, genDir, SEED)
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("projection/scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
