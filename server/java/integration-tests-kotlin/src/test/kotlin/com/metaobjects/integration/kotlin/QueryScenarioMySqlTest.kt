package com.metaobjects.integration.kotlin

import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.util.stream.Stream

/**
 * The persistence corpus' report scenarios (`report-*.yaml`) on MySQL, through Exposed. The schema
 * is the TS-produced `canonical/schema.mysql.sql` (hand tables plus the `buildReportViews` mysql
 * views), executed verbatim; the same Postgres `expect` blocks are asserted, with the seed re-spelled
 * by [ScenarioEngine.toMysqlSeed].
 *
 * One MySQL server serves every scenario; each starts from an empty schema. Not registered in the
 * parent reactor (it needs docker) -- run via `mvn -f server/java/integration-tests-kotlin/pom.xml test`.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
internal class QueryScenarioMySqlTest {

    private var mysql: MySqlContainer? = null

    @BeforeAll
    fun startServer() {
        mysql = MySqlContainer()
    }

    @AfterAll
    fun stopServer() {
        mysql?.close()
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun reportScenario(name: String, scenario: Scenarios.QueryScenario) {
        val server = mysql!!
        assertDoesNotThrow {
            QueryScenarioRunner.run(scenario, server.jdbcUrl, server.username, server.password, ScenarioEngine.MYSQL)
        }
    }

    companion object {
        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ScenarioLoader.findCorpusRoot()
            val reports = ScenarioLoader.loadQueries(corpus.resolve("queries")).filter { it.name.startsWith("report-") }
            Assumptions.assumeTrue(reports.isNotEmpty(), "No report-* scenarios under fixtures/persistence-conformance/queries")
            return reports.stream().map { Arguments.of(it.name, it) }
        }
    }
}
