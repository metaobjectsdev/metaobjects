package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.QueryScenario;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.jupiter.api.AfterAll;
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
 * The persistence corpus' report scenarios ({@code report-*.yaml}) on MySQL, through the OMDB
 * {@code MySQLDriver}. The schema is the TS-produced {@code canonical/schema.mysql.sql} (hand
 * tables plus the {@code buildReportViews} mysql views), executed verbatim; the same Postgres
 * {@code expect} blocks are asserted, with MySQL's value spelling mapped onto the wire form by
 * {@link QueryScenarioRunner} (a DATETIME is a UTC wall clock) and the seed re-spelled by
 * {@link ScenarioEngine#toMysqlSeed}.
 *
 * <p>One MySQL server serves every scenario; each starts from an empty schema. Not part of the
 * default Maven reactor build (it needs docker).</p>
 */
final class QueryScenarioMySqlTests {

    private static final Path CORPUS = ScenarioLoader.findCorpusRoot();
    private static final List<QueryScenario> SCENARIOS =
        ScenarioLoader.loadQueries(CORPUS.resolve("queries")).stream()
            .filter(s -> s.name().startsWith("report-")).toList();

    private static MySqlContainer mysql;

    @BeforeAll
    static void beforeAll() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        Map<String, Class<?>> bindings = new HashMap<>();
        // The entities the report views read; a report itself is served by its read model.
        for (String entity : List.of("Program", "Week", "Asset")) {
            bindings.put("fitness::" + entity, ValueObject.class);
        }
        reg.register(() -> bindings);
        ObjectClassRegistry.setGlobal(reg);
        mysql = new MySqlContainer();
    }

    @AfterAll
    static void afterAll() {
        if (mysql != null) mysql.close();
    }

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void reportScenario(String name, QueryScenario scenario) {
        assertDoesNotThrow(() -> QueryScenarioRunner.run(scenario, mysql, CORPUS.resolve("canonical"), ScenarioEngine.MYSQL));
    }
}
