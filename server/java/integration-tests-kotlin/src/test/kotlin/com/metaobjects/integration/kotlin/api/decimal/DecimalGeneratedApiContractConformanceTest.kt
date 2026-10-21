package com.metaobjects.integration.kotlin.api.decimal

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
 * ADR-0019 Amendment 1 (W1 to W4): the Kotlin GENERATED-controller lane for the `decimal/` api-contract
 * sub-corpus, on real Postgres, SQLite and MySQL. A decimal is a canonical string on the wire, a request
 * takes a string or a number in the JSON-number grammar, a filter operand is compared exactly, and a value
 * the column cannot hold is `400 validation`. Reuses the report lane's harness (same mechanics: the
 * committed schema executed verbatim, the base tables seeded, the emitted controllers hosted unmodified).
 * Generated lane only, as every port runs it.
 */
@DisplayName("API contract decimal (ADR-0019 Amendment 1) - GENERATED Kotlin Spring controllers over embedded Tomcat, real databases")
internal class DecimalGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "postgres {0}")
    @MethodSource("scenarios")
    fun scenarioOnPostgres(name: String, scenario: ApiScenario) =
        run(scenario, ReportDb(ScenarioEngine.POSTGRES, PG.jdbcUrl, PG.username, PG.password))

    @ParameterizedTest(name = "sqlite {0}")
    @MethodSource("scenarios")
    fun scenarioOnSqlite(name: String, scenario: ApiScenario, @TempDir dir: Path) =
        run(scenario, ReportDb(ScenarioEngine.SQLITE, "jdbc:sqlite:${dir.resolve("decimal.db")}", "", ""))

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
    fun `the corpus has its eight scenarios`() {
        // A lane that silently ran fewer would still be green.
        assertEquals(8, scenarios().count())
    }

    @Test
    fun `the entity and the report both get a controller`() {
        for (name in GeneratedReportControllerHarness.DECIMAL_SERVED) {
            assertTrue("acme/ledger/${name}Controller.kt" in HARNESS.emittedFiles, "$name was not generated")
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
            val genDir = Files.createTempDirectory("decimal-generated-kotlin-controller")
            HARNESS = GeneratedReportControllerHarness(
                corpus, genDir, lane = "decimal", entityPkg = "acme.ledger",
                served = GeneratedReportControllerHarness.DECIMAL_SERVED,
            )
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
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("decimal/scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}
