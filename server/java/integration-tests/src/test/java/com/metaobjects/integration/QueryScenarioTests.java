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
    private static final Map<String, String> EXPECTED_FAILURES = Map.of(
        // TPH (table-per-hierarchy) runtime support — discriminator injection on create +
        // subtype-scoped reads — is a separate deferred slice for the Java port (corpus README:
        // "Java/Kotlin/Python/C# runtime TPH lands in their Tier-4 slice; until then those ports
        // skip the tph-*.yaml scenarios"). Out of scope for the W2b write-ops/zone-codec unit.
        "tph-insert-then-find-by-id", "TPH runtime support (discriminator + subtype-scoped reads) is a deferred Java slice",
        "tph-insert-three-subtypes-list", "TPH runtime support (discriminator + subtype-scoped reads) is a deferred Java slice",
        "tph-no-cross-subtype-update", "TPH runtime support (discriminator + subtype-scoped reads) is a deferred Java slice",
        "tph-update-subtype-only-column", "TPH runtime support (discriminator + subtype-scoped reads) is a deferred Java slice");

    @BeforeAll
    static void beforeAll() {
        // W2b zone-codec fix: the JVM default zone is INTENTIONALLY NOT pinned here. The
        // cross-port persistence corpus is UTC-canonical (TIMESTAMP / DATE values are seeded and
        // asserted as a UTC wall clock — normalization.md), and the OMDB date/timestamp codecs are
        // now zone-free: the DATE + plain-TIMESTAMP codecs bind/read via getTimestamp/getDate with
        // a UTC Calendar, and Normalization recovers the wall clock as `instant @ UTC` rather than
        // the default-zone toLocalDateTime(). So the gate proves zone-independence — it must pass
        // under the agent host's local zone (and any -Duser.timezone), with no UTC pin. (The
        // tz-aware TIMESTAMPTZ path stores an absolute instant and was already zone-independent.)

        // Bind every canonical-package entity FQN to ValueObject so ObjectManagerDB
        // can instantiate rows without a project-specific POJO. Build the registry
        // once and publish it via setGlobal — subsequent test runs in the same JVM
        // pick up the existing global (ObjectClassRegistry.register throws on
        // conflicting bindings, so we only set when none is set or the bindings
        // already include ours).
        ObjectClassRegistry reg = new ObjectClassRegistry();
        Map<String, Class<?>> bindings = new java.util.HashMap<>();
        bindings.put("fitness::Program",     ValueObject.class);
        bindings.put("fitness::Week",        ValueObject.class);
        bindings.put("fitness::Measurement", ValueObject.class);
        bindings.put("fitness::Asset",       ValueObject.class);
        bindings.put("fitness::ProgramView", ValueObject.class);
        bindings.put("fitness::ProgramStat", ValueObject.class);
        // FR-017 M:N corpus entities (hetero + self-join junctions + targets).
        bindings.put("fitness::Post",        ValueObject.class);
        bindings.put("fitness::Tag",         ValueObject.class);
        bindings.put("fitness::PostTag",     ValueObject.class);
        bindings.put("fitness::Person",      ValueObject.class);
        bindings.put("fitness::Follow",      ValueObject.class);
        bindings.put("fitness::Friendship",  ValueObject.class);
        // SP-H Unit 5 op:roundtrip — the every-subtype write keystone + its jsonb value object.
        bindings.put("fitness::AllTypes",    ValueObject.class);
        bindings.put("fitness::Settings",    ValueObject.class);
        reg.register(() -> bindings);
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
