package com.metaobjects.integration.kotlin.api.writethrough

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import com.metaobjects.integration.kotlin.api.writethrough.generated.GeneratedWriteThroughControllerHarness
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
 * #214 write-through read-your-writes api-contract conformance — Kotlin GENERATED-controller lane.
 *
 * Drives the **generated** Kotlin Spring `OrderController` (writes → OrderTable, reads/re-reads →
 * OrderView) over HTTP via [GeneratedWriteThroughControllerHarness] (generate→compile→MockMvc + a
 * hand-created H2 `v_order_with_customer` view). Proves the deployed Kotlin write-through artifact
 * returns the derived `customerName` on read-your-writes (POST create's re-read + GET through the
 * view). Generated lane only — a hand-rolled reference controller would re-implement the join and
 * prove nothing about the emitted artifact.
 */
@DisplayName("API contract write-through (#214) — GENERATED Kotlin Spring controller over MockMvc")
internal class WriteThroughGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            HARNESS.reset() // fresh H2 + view + seed per scenario (create mutates)
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path, req.body)
                val parsed = HARNESS.parseBody(res.body)
                ApiContractAssertions.assertResponse(scenario.name, req, res.status, parsed)
            }
        }
    }

    companion object {
        private val MAPPER = ObjectMapper()

        @Suppress("UNCHECKED_CAST")
        private val SEED: Pair<List<Map<String, Any?>>, List<Map<String, Any?>>> by lazy {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val text = Files.readString(corpus.resolve("write-through/seed.json"), StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            val customers = (parsed["customers"] as? List<Map<String, Any?>>) ?: error("write-through/seed.json: missing 'customers'")
            val orders = (parsed["orders"] as? List<Map<String, Any?>>) ?: error("write-through/seed.json: missing 'orders'")
            customers to orders
        }

        private lateinit var HARNESS: GeneratedWriteThroughControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val genDir = Files.createTempDirectory("issue214-generated-kotlin-write-through-controller")
            HARNESS = GeneratedWriteThroughControllerHarness(corpus, genDir, SEED.first, SEED.second)
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("write-through/scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
