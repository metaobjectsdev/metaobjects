package com.metaobjects.integration.kotlin

import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.nio.file.Path
import java.util.stream.Stream

/**
 * The persistence corpus' report scenarios (`report-*.yaml`) on SQLite, through Exposed. The schema
 * is the TS-produced `canonical/schema.sqlite.sql` (the `meta migrate` tables plus report views),
 * executed verbatim; the same Postgres `expect` blocks are asserted. SQLite is embedded, so each
 * scenario gets a fresh database file and no container.
 */
internal class QueryScenarioSqliteTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun reportScenario(name: String, scenario: Scenarios.QueryScenario, @TempDir dir: Path) {
        assertDoesNotThrow {
            QueryScenarioRunner.run(scenario, "jdbc:sqlite:${dir.resolve("scenario.db")}", "", "", ScenarioEngine.SQLITE)
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
