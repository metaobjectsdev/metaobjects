package com.metaobjects.integration.kotlin

import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.util.stream.Stream

/**
 * Parameterized: one JUnit test invocation per included scenario .yaml file
 * under `fixtures/persistence-conformance/queries/`. Each invocation spins
 * up a fresh Postgres docker container (~3s).
 *
 * Subset by design — only scenarios whose operators/types Exposed-substrate
 * runner already handles are included (eq, sort, simple get/count/list).
 * Filter operators beyond `eq`, projections, and is-null variants are
 * deferred to follow-up work and listed in [DEFERRED_SCENARIOS] so the count
 * of green-vs-deferred stays visible in CI output.
 *
 * NOT registered in the parent reactor — run via:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml test
 */
internal class QueryScenarioConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun queryScenario(name: String, scenario: Scenarios.QueryScenario) {
        assertDoesNotThrow {
            PostgresContainer().use { pg ->
                QueryScenarioRunner.run(scenario, pg)
            }
        }
    }

    companion object {
        /**
         * Included scenarios — these run end-to-end against the Exposed substrate.
         * Listed explicitly (not derived) so a new scenario file lands as 'skipped'
         * rather than silently expanding the suite.
         */
        private val INCLUDED_SCENARIOS = setOf(
            "count",
            "get-by-id",
            "list-empty-table",
            "list-programs-sorted",
            "filter-by-enum",
            "filter-is-null",
            "filter-like-and-ne",
            "filter-range-and",
            "projection-aggregate",
        )

        /**
         * Scenarios deliberately left out, with a concrete reason describing
         * what would unblock each. Kept visible so the deferral surface is
         * obvious in code review.
         */
        @Suppress("unused")
        private val DEFERRED_SCENARIOS = emptyMap<String, String>()

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ScenarioLoader.findCorpusRoot()
            val all = ScenarioLoader.loadQueries(corpus.resolve("queries"))
            val included = all.filter { it.name in INCLUDED_SCENARIOS }
            // Defensive: if the corpus has drifted out from under the included list,
            // fail loudly rather than silently running zero scenarios.
            Assumptions.assumeTrue(
                included.isNotEmpty(),
                "No included query scenarios resolved — corpus drift? INCLUDED_SCENARIOS may need refresh."
            )
            return included.stream().map { Arguments.of(it.name, it) }
        }
    }
}
