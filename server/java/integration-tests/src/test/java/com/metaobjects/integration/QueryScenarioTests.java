package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.QueryScenario;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.jupiter.api.BeforeAll;
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
 * {@code fixtures/persistence-conformance/queries/}. Each invocation spins
 * up a fresh Postgres testcontainer.
 *
 * <p>NOT part of the default Maven reactor build — run via
 * {@code mvn -f server/java/integration-tests/pom.xml test} or
 * {@code scripts/integration-test.sh java}.</p>
 *
 * <h2>ObjectClassRegistry binding</h2>
 * <p>{@link com.metaobjects.object.MetaObject#getObjectClass()} resolves an
 * entity's instance class via {@code @object} attr → ObjectClassRegistry →
 * FQN-to-Java-class fallback. The cross-port corpus declares entities without
 * {@code @object} attrs and there are no {@code fitness.Program} / etc.
 * classes on the classpath, so {@link #beforeAll} binds every canonical
 * entity to {@link ValueObject} (which is a {@code Map<String,Object>} and
 * trivially carries any field set). Mirrors how a deploying project would
 * register its own POJOs via {@code ObjectClassBindingProvider} ServiceLoader.</p>
 */
final class QueryScenarioTests {

    private static final Path CORPUS = ScenarioLoader.findCorpusRoot();
    private static final List<QueryScenario> SCENARIOS =
        ScenarioLoader.loadQueries(CORPUS.resolve("queries"));

    /**
     * Scenarios deferred until the underlying Java port gap is closed.
     *
     * <p>None: schema authority is now the committed canonical DDL
     * (ADR-0015), which materializes the aggregate-projection view
     * ({@code v_program_stat}) directly. The previous {@code projection-aggregate}
     * deferral — the view body had been synthesized by the removed migration
     * engine — no longer applies: OMDB no longer creates views, and the OMDB
     * runtime simply reads the TS-authored view through its projection-read
     * path.</p>
     */
    private static final Map<String, String> EXPECTED_FAILURES = Map.of();

    @BeforeAll
    static void beforeAll() {
        // The cross-port persistence corpus is UTC-canonical: TIMESTAMP / TIMESTAMPTZ
        // instants are seeded and asserted in UTC wall-clock (normalization.md). Pin the
        // JVM default zone to UTC so java.sql.Timestamp → LocalDateTime yields the UTC
        // wall clock the fixtures expect, instead of the agent host's local zone. (Mirrors
        // the TS/C# runners, which normalize TIMESTAMPTZ to UTC.)
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"));

        // Bind every canonical-package entity FQN to ValueObject so ObjectManagerDB
        // can instantiate rows without a project-specific POJO. Build the registry
        // once and publish it via setGlobal — subsequent test runs in the same JVM
        // pick up the existing global (ObjectClassRegistry.register throws on
        // conflicting bindings, so we only set when none is set or the bindings
        // already include ours).
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of(
            "fitness::Program",     ValueObject.class,
            "fitness::Week",        ValueObject.class,
            "fitness::Measurement", ValueObject.class,
            "fitness::Asset",       ValueObject.class,
            "fitness::ProgramView", ValueObject.class,
            "fitness::ProgramStat", ValueObject.class
        ));
        ObjectClassRegistry.setGlobal(reg);
    }

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void queryScenario(String name, QueryScenario scenario) {
        String deferralReason = EXPECTED_FAILURES.get(name);
        if (deferralReason != null) abort(deferralReason);

        assertDoesNotThrow(() -> {
            try (PostgresContainer pg = new PostgresContainer()) {
                QueryScenarioRunner.run(scenario, pg, CORPUS.resolve("canonical"));
            }
        });
    }
}
