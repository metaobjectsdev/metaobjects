package com.metaobjects.integration.kotlin.api.tph

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import com.metaobjects.integration.kotlin.api.tph.generated.GeneratedTphControllerHarness
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
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

    /**
     * FR-009 filter parity for TPH lists — not covered by the shared corpus, so this local smoke
     * exercises the generated filter pipeline the Java/Python/TS lanes also expose: filter the
     * polymorphic list by a subtype column, filter a per-subtype list (discriminator AND'd with the
     * predicate), and reject an unknown filter field with the cross-port 400 envelope.
     */
    @Test
    @Suppress("UNCHECKED_CAST")
    fun tphListsSupportFr009Filters() {
        HARNESS.reset() // seed: Bridge id1 (quantity 5), Copay id2, PriorAuth id3
        val r1 = HARNESS.exchange("GET", "/api/auths?filter[quantity][eq]=5&sort=id:asc", null)
        assertEquals(200, r1.status)
        val rows1 = HARNESS.parseBody(r1.body) as List<Map<String, Any?>>
        assertEquals(1, rows1.size)
        assertEquals(1, (rows1[0]["id"] as Number).toInt())
        val r2 = HARNESS.exchange("GET", "/api/auths/bridge?filter[reference][eq]=REF-1", null)
        assertEquals(200, r2.status)
        assertEquals(1, (HARNESS.parseBody(r2.body) as List<*>).size)
        val r3 = HARNESS.exchange("GET", "/api/auths/bridge?filter[reference][eq]=NOPE", null)
        assertEquals(200, r3.status)
        assertEquals(0, (HARNESS.parseBody(r3.body) as List<*>).size)
        val r4 = HARNESS.exchange("GET", "/api/auths?filter[bogus][eq]=x", null)
        assertEquals(400, r4.status)
        assertEquals("invalid_filter_field", (HARNESS.parseBody(r4.body) as Map<String, Any?>)["error"])
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
