package com.metaobjects.integration.kotlin.api.report

import com.metaobjects.integration.kotlin.MySqlContainer
import com.metaobjects.integration.kotlin.PostgresContainer
import com.metaobjects.integration.kotlin.ScenarioEngine
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import com.metaobjects.integration.kotlin.api.report.generated.GeneratedReportControllerHarness
import com.metaobjects.integration.kotlin.api.report.generated.GeneratedReportControllerHarness.ReportDb
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.nio.file.Files
import java.nio.file.Path
import java.util.stream.Stream

/**
 * FR-044 Plan 3: the Kotlin GENERATED-controller lane for the view-backed-report
 * api-contract sub-corpus. Drives the corpus's served reports' generated read-only
 * controllers over an embedded Tomcat: GET list with the FR-009 filter and sort allowlists over the report's
 * DERIVED fields, `POST` answering `405 {"error": "method_not_allowed"}`, and no `/{id}`.
 *
 * Generated lane ONLY, on purpose and on every port (see the sub-corpus README): what is
 * under test is whether the port's GENERATOR emits a route for a served report. A
 * hand-rolled reference controller would answer every scenario by construction.
 */
@DisplayName("API contract report (FR-044) — GENERATED Kotlin Spring controllers over embedded Tomcat, real views")
internal class ReportGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "postgres {0}")
    @MethodSource("scenarios")
    fun scenarioOnPostgres(name: String, scenario: ApiScenario) =
        run(scenario, ReportDb(ScenarioEngine.POSTGRES, PG.jdbcUrl, PG.username, PG.password))

    @ParameterizedTest(name = "sqlite {0}")
    @MethodSource("scenarios")
    fun scenarioOnSqlite(name: String, scenario: ApiScenario, @TempDir dir: Path) =
        run(scenario, ReportDb(ScenarioEngine.SQLITE, "jdbc:sqlite:${dir.resolve("report.db")}", "", ""))

    @ParameterizedTest(name = "mysql {0}")
    @MethodSource("scenarios")
    fun scenarioOnMySql(name: String, scenario: ApiScenario) =
        run(scenario, ReportDb(ScenarioEngine.MYSQL, MYSQL.jdbcUrl, MYSQL.username, MYSQL.password))

    /** A fresh schema (real tables and views) and base-table seed per scenario, then the requests over HTTP. */
    private fun run(scenario: ApiScenario, db: ReportDb) {
        // `engines:` is exact: a scenario that names other engines is not this engine's.
        Assumptions.assumeTrue(scenario.runsOn(db.engine.name), "${scenario.name} does not run on ${db.engine}")
        assertDoesNotThrow {
            HARNESS.reset(db)
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path, req.body)
                val parsed = HARNESS.parseBody(res.body)
                ApiContractAssertions.assertResponse(scenario.name, req, res.status, parsed)
            }
        }
    }

    @Test
    fun `the corpus has its twenty-seven scenarios`() {
        // A lane that silently ran fewer would still be green.
        assertEquals(27, scenarios().count())
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
        // One server per engine for the class; each scenario rebuilds its schema on it. Lazy, so a
        // run that selects one engine's tests does not boot the others' containers.
        private val PG by lazy { PostgresContainer() }
        private val MYSQL by lazy { MySqlContainer() }

        private lateinit var HARNESS: GeneratedReportControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val genDir = Files.createTempDirectory("fr044-generated-kotlin-report-controller")
            HARNESS = GeneratedReportControllerHarness(corpus, genDir)
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
            runCatching { PG.close() }
            runCatching { MYSQL.close() }
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("report/scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
