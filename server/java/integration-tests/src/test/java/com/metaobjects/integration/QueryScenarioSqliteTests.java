package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.QueryScenario;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

/**
 * The persistence corpus' report scenarios ({@code report-*.yaml}) on SQLite, through the OMDB
 * {@code SQLiteDriver}. The schema is the TS-produced {@code canonical/schema.sqlite.sql} (the
 * {@code meta migrate} tables plus the report views), executed verbatim; the same Postgres
 * {@code expect} blocks are asserted, with SQLite's value spelling mapped onto the wire form by
 * {@link QueryScenarioRunner}. SQLite is embedded, so each scenario gets its own database file
 * and the lane needs no docker.
 */
final class QueryScenarioSqliteTests {

    private static final Path CORPUS = ScenarioLoader.findCorpusRoot();
    private static final List<QueryScenario> SCENARIOS =
        ScenarioLoader.loadQueries(CORPUS.resolve("queries")).stream()
            .filter(ScenarioEngine.SQLITE::runs).toList();

    @BeforeAll
    static void beforeAll() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        Map<String, Class<?>> bindings = new HashMap<>();
        // The entities the report views read; a report itself is served by its read model.
        for (String entity : List.of("Program", "Week", "Asset", "Entry", "Gadget", "GadgetEvent")) {
            bindings.put("fitness::" + entity, ValueObject.class);
        }
        reg.register(() -> bindings);
        ObjectClassRegistry.setGlobal(reg);
    }

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void reportScenario(String name, QueryScenario scenario) {
        assertDoesNotThrow(() -> {
            try (SqliteDatabase db = new SqliteDatabase()) {
                QueryScenarioRunner.run(scenario, db, CORPUS.resolve("canonical"), ScenarioEngine.SQLITE);
            }
        });
    }
}
