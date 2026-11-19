package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.QueryScenario;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.net.URISyntaxException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * field.duration orders on every engine (port-local scenario {@code duration-ordering/}): a range
 * filter, an equality across spellings and a sort, through OMDB, on Postgres (native interval)
 * and SQLite (a 64-bit microsecond count).
 */
final class DurationOrderingScenarioTests {

    private static final Path CORPUS = ScenarioLoader.findCorpusRoot();

    private static QueryScenario scenario() throws URISyntaxException {
        Path dir = Path.of(DurationOrderingScenarioTests.class.getResource("/duration-ordering").toURI());
        List<QueryScenario> all = ScenarioLoader.loadQueries(dir);
        assertEquals(1, all.size());
        return all.get(0);
    }

    @BeforeAll
    static void beforeAll() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of("fitness::AllTypes", ValueObject.class));
        ObjectClassRegistry.setGlobal(reg);
    }

    @Test
    void ordersOnSqlite() throws Exception {
        QueryScenario s = scenario();
        assertDoesNotThrow(() -> {
            try (SqliteDatabase db = new SqliteDatabase()) {
                QueryScenarioRunner.run(s, db, CORPUS.resolve("canonical"), ScenarioEngine.SQLITE);
            }
        });
    }

    @Test
    void ordersOnPostgres() throws Exception {
        QueryScenario s = scenario();
        assertDoesNotThrow(() -> {
            try (PostgresContainer pg = new PostgresContainer()) {
                QueryScenarioRunner.run(s, pg, CORPUS.resolve("canonical"));
            }
        });
    }
}
