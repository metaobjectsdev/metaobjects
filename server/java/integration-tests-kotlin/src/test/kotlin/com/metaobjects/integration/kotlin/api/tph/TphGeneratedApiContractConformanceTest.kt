package com.metaobjects.integration.kotlin.api.tph

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
 * FR-017 Tier 4/5 — cross-port TPH polymorphic-CRUD api-contract conformance, Kotlin
 * GENERATED-controller lane.
 *
 * Drives the **generated** Kotlin Spring `AuthController` (the polymorphic collection + per-subtype
 * CRUD set emitted by `codegen-kotlin` for the discriminator base) over HTTP via
 * [GeneratedTphControllerHarness] (generate→compile→MockMvc). It proves the deployed Kotlin TPH
 * routing artifact — discriminator injection from the URL, subtype-scoped reads/writes, and the
 * cross-subtype 404 — implements the cross-port contract, not just a hand-written stand-in.
 *
 * The generated controller + union `Auth` data class + union `AuthTable` are hosted UNMODIFIED. The
 * only hand-written piece is the in-memory H2 (Exposed) bootstrap + the per-subtype POST seeding
 * (the consumer persistence seam); single-table runtime semantics are gated separately by
 * `persistence-conformance`'s `tph-*` query scenarios. Same 4 scenarios, same [ApiContractAssertions]
 * as every other port's TPH lane.
 */
@DisplayName("API contract TPH — GENERATED Kotlin Spring controller (codegen-kotlin) over MockMvc")
internal class TphGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            HARNESS.reset() // each TPH scenario mutates the table — fresh seed per scenario
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path, req.body)
                val parsed = HARNESS.parseBody(res.body)
                ApiContractAssertions.assertResponse(scenario.name, req, res.status, parsed)
            }
        }
    }

    companion object {
        private val MAPPER = ObjectMapper()

        /** The single TPH table's seed rows (one per subtype), keyed by table name `auths`. */
        @Suppress("UNCHECKED_CAST")
        private val SEED_ROWS: List<Map<String, Any?>> by lazy {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val text = Files.readString(corpus.resolve("tph/seed.json"), StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["auths"] as? List<Map<String, Any?>>) ?: error("tph/seed.json: missing 'auths' array")
        }

        private lateinit var HARNESS: GeneratedTphControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val genDir = Files.createTempDirectory("fr017-generated-kotlin-tph-controller")
            HARNESS = GeneratedTphControllerHarness(corpus, genDir, SEED_ROWS)
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("tph/scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
