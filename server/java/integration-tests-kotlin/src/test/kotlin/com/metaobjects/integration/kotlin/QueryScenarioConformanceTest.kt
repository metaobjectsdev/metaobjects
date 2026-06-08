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
 * Runs EVERY scenario under that directory except those explicitly listed in
 * [DEFERRED_SCENARIOS] (each with a reason). A newly-added scenario auto-runs
 * (or auto-fails, forcing a deliberate deferral entry) rather than silently
 * dropping out of the Kotlin suite — matching the glob+ledger discovery the
 * other ports use.
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
         * Scenarios deliberately deferred, each with a concrete reason describing
         * what would unblock it. EVERY OTHER scenario under
         * fixtures/persistence-conformance/queries/ runs automatically: a newly
         * added fixture auto-runs (or auto-fails, forcing a deliberate entry here)
         * rather than silently dropping out of the Kotlin suite.
         *
         * FR-017 TPH (table-per-hierarchy) now lands in the Kotlin port — the single `auths`
         * Exposed [com.metaobjects.integration.kotlin.tables.AuthTable] plus the discriminator
         * inject/scope/project + op:create / expect-error dispatch in [QueryScenarioRunner] — so
         * the `tph-*.yaml` scenarios run. No scenarios are currently deferred.
         */
        private val DEFERRED_SCENARIOS = emptyMap<String, String>()

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ScenarioLoader.findCorpusRoot()
            val all = ScenarioLoader.loadQueries(corpus.resolve("queries"))
            // Guard: a missing/empty corpus dir is an environment problem, not a
            // conformance result — skip rather than report zero green scenarios.
            Assumptions.assumeTrue(
                all.isNotEmpty(),
                "No query scenarios found under fixtures/persistence-conformance/queries — corpus missing?"
            )
            return all
                .filter { it.name !in DEFERRED_SCENARIOS.keys }
                .stream()
                .map { Arguments.of(it.name, it) }
        }
    }
}
