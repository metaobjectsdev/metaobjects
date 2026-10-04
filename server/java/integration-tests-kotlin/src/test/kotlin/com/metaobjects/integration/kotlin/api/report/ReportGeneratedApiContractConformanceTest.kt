package com.metaobjects.integration.kotlin.api.report

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import com.metaobjects.integration.kotlin.api.report.generated.GeneratedReportControllerHarness
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
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
 * FR-044 Plan 3: the Kotlin GENERATED-controller lane for the view-backed-report
 * api-contract sub-corpus. Drives the three generated read-only report controllers over an
 * embedded Tomcat: GET list with the FR-009 filter and sort allowlists over the report's
 * DERIVED fields, `POST` answering `405 {"error": "method_not_allowed"}`, and no `/{id}`.
 *
 * Generated lane ONLY, on purpose and on every port (see the sub-corpus README): what is
 * under test is whether the port's GENERATOR emits a route for a served report. A
 * hand-rolled reference controller would answer every scenario by construction.
 */
@DisplayName("API contract report (FR-044) — GENERATED Kotlin Spring controllers over embedded Tomcat")
internal class ReportGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            HARNESS.reset() // fresh H2 + stand-in tables + seed per scenario
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path, req.body)
                val parsed = HARNESS.parseBody(res.body)
                ApiContractAssertions.assertResponse(scenario.name, req, res.status, parsed)
            }
        }
    }

    @Test
    fun `the corpus has its twelve scenarios`() {
        // A lane that silently ran fewer would still be green.
        assertEquals(12, scenarios().count())
    }

    @Test
    fun `the sourceless report generates nothing`() {
        // InvoiceDays declares no view. A port that served every report it found would emit
        // a table no schema has and a route no scenario calls.
        val leaked = HARNESS.emittedFiles.filter { "InvoiceDays" in it }
        assertTrue(leaked.isEmpty(), "InvoiceDays leaked into $leaked")
        for (report in GeneratedReportControllerHarness.SERVED) {
            for (suffix in listOf("", "Table", "FilterAllowlist", "Controller")) {
                assertTrue("acme/sales/$report$suffix.kt" in HARNESS.emittedFiles, "$report$suffix was not generated")
            }
        }
    }

    companion object {
        private val MAPPER = ObjectMapper()

        /**
         * The `reports` half of the seed: what the three views return for the seeded
         * invoices. This lane's H2 tables stand in for the views (no view SQL is written in
         * Kotlin), so they are seeded with the views' rows, not with the base table's.
         */
        @Suppress("UNCHECKED_CAST")
        private val SEED: Map<String, List<Map<String, Any?>>> by lazy {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val text = Files.readString(corpus.resolve("report/seed.json"), StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["reports"] as? Map<String, List<Map<String, Any?>>>)
                ?: error("report/seed.json: missing 'reports'")
        }

        private lateinit var HARNESS: GeneratedReportControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val genDir = Files.createTempDirectory("fr044-generated-kotlin-report-controller")
            HARNESS = GeneratedReportControllerHarness(corpus, genDir, SEED)
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("report/scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
