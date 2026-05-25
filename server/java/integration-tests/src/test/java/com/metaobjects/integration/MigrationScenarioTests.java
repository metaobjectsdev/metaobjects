package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.MigrationScenario;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assumptions.abort;

/**
 * Parameterized: one JUnit test invocation per .yaml file in
 * {@code fixtures/persistence-conformance/migrations/}. Each invocation spins
 * up a fresh Postgres testcontainer, so scenarios are fully isolated.
 *
 * <p>NOT part of the default Maven reactor build — run via
 * {@code mvn -f server/java/integration-tests/pom.xml test}
 * (or {@code scripts/integration-test.sh java}).</p>
 *
 * <h2>Expected failures</h2>
 * <p>{@link #EXPECTED_FAILURES} maps scenario names to the Java-port gap that
 * keeps them red. JUnit reports those as skipped rather than failing the run,
 * so a clean run still means {@code BUILD SUCCESS} while the gap stays visible.
 * Mirrors {@code conformance-expected-failures.json} in the Java metadata module.</p>
 */
final class MigrationScenarioTests {

    /**
     * Scenarios deferred until the underlying Java port gap is closed. The
     * harness still loads + parses them; we abort with the documented reason
     * before running them so {@code BUILD SUCCESS} stays meaningful.
     */
    private static final Map<String, String> EXPECTED_FAILURES = Map.of(
        "bootstrap-canonical-from-empty",
        // Three independent Java gaps surface on the canonical fixture:
        //   1. ExpectedSchemaBuilder.tableDescriptor returns indexes=[] / foreignKeys=[]
        //      (`indexes: empty in v1` literal in the source), so unique-index +
        //      FK CREATE statements never appear in the up SQL.
        //   2. SimpleMappingHandlerDB doesn't surface @required / identity.primary
        //      NOT-NULL on columns from the new-metadata layer.
        //   3. The view-DDL pipeline emits `CREATE OR REPLACE VIEW "v_program" AS null`
        //      because Java has no port of the TS expected-views.ts / C#
        //      PostgresSchema.CreateView origin-walker.
        // Track-and-skip pattern matches `conformance-expected-failures.json`.
        "deferred: Java omdb migration pipeline needs index/FK emission, "
        + "NOT-NULL inference from identity.primary + @required, and a "
        + "projection-view body builder porting passthrough/aggregate origins"
    );

    private static List<MigrationScenario> SCENARIOS;

    static Stream<Arguments> scenarios() {
        if (SCENARIOS == null) {
            Path corpus = ScenarioLoader.findCorpusRoot();
            SCENARIOS = ScenarioLoader.loadMigrations(corpus.resolve("migrations"));
        }
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void migrationScenario(String name, MigrationScenario scenario) {
        String deferralReason = EXPECTED_FAILURES.get(name);
        if (deferralReason != null) abort(deferralReason);

        assertDoesNotThrow(() -> {
            try (PostgresContainer pg = new PostgresContainer()) {
                MigrationScenarioRunner.run(scenario, pg);
            }
        });
    }
}
