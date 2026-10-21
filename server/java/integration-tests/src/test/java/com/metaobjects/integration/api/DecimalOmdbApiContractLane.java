package com.metaobjects.integration.api;

import com.metaobjects.integration.JdbcTarget;
import com.metaobjects.integration.QueryScenarioRunner;
import com.metaobjects.integration.ScenarioEngine;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedDecimalControllerHarness;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * ADR-0019 Amendment 1 - the Java full-stack lane of the {@code decimal/} api-contract sub-corpus on a
 * real database; one subclass per engine. The artifacts under test are the GENERATED
 * {@code EntryController} / {@code EntryTotalsController}, DTOs, allowlists and repository interfaces,
 * mounted unmodified on embedded Tomcat over OMDB-backed repositories. The database executes the
 * committed TypeScript-produced {@code decimal/schema.<engine>.sql} verbatim; {@code entries} is
 * truncated and re-seeded before EVERY scenario (the scenarios write), and the real view derives the
 * report. A scenario's {@code engines:} list is exact.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
abstract class DecimalOmdbApiContractLane {

    private final List<ApiScenario> scenarios = ApiContractScenarioLoader.loadScenarios(DecimalCorpus.scenariosDir());

    private GeneratedDecimalControllerHarness harness;
    private JdbcTarget target;

    abstract ScenarioEngine engine();

    abstract JdbcTarget openDatabase();

    abstract void closeDatabase();

    @BeforeAll
    void setUp() throws Exception {
        target = openDatabase();
        provisionSchema();

        harness = new GeneratedDecimalControllerHarness(DecimalCorpus.root(), Files.createTempDirectory("decimal-omdb-controllers"));

        ObjectClassRegistry reg = new ObjectClassRegistry();
        Map<String, Class<?>> bindings = new HashMap<>();
        bindings.put("acme::ledger::Entry", ValueObject.class);
        reg.register(() -> bindings);
        ObjectClassRegistry.setGlobal(reg);

        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(engine().newDriver());
        omdb.setDataSource(dataSource());
        omdb.init();
        harness.start(omdb);
    }

    @AfterAll
    void tearDown() throws Exception {
        try {
            if (harness != null) harness.close();
        } finally {
            closeDatabase();
        }
    }

    Stream<Arguments> scenarios() {
        return scenarios.stream()
            .filter(s -> ApiContractScenarioLoader.runsOn(s, engine().id()))
            .map(s -> Arguments.of(s.name(), s));
    }

    @Test
    void theEngineRunsAtLeastTheFifteenDigitSubset() {
        // A scenarios directory that resolved to nothing, or an engines: filter that dropped
        // everything, would leave this lane green and empty.
        assertFalse(scenarios().findAny().isEmpty());
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String name, ApiScenario scenario) {
        assertDoesNotThrow(() -> {
            reseed();
            for (ApiRequest req : scenario.requests()) {
                GeneratedDecimalControllerHarness.Response res =
                    harness.exchange(req.method(), req.path(), req.body());
                Object parsed = harness.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
        });
    }

    // -----------------------------------------------------------------------
    // database provisioning
    // -----------------------------------------------------------------------

    private void provisionSchema() throws SQLException {
        ScenarioEngine engine = engine();
        String schema = DecimalCorpus.schema(engine.id());
        try (Connection c = connection()) {
            if (engine == ScenarioEngine.POSTGRES) {
                try (Statement s = c.createStatement()) { s.execute(schema); }
            } else {
                List<String> statements = ScenarioEngine.splitStatements(schema);
                if (engine == ScenarioEngine.MYSQL) QueryScenarioRunner.dropSchema(c, statements);
                try (Statement s = c.createStatement()) {
                    for (String stmt : statements) s.execute(stmt);
                }
            }
        }
    }

    /** Empty {@code entries}, insert the seed rows under their own ids, and park the counter after them. */
    private void reseed() throws SQLException {
        ScenarioEngine engine = engine();
        String q = engine.quote();
        List<Map<String, Object>> rows = DecimalCorpus.entries();
        long next = rows.stream().mapToLong(r -> ((Number) r.get("id")).longValue()).max().orElse(0) + 1;
        try (Connection c = connection(); Statement s = c.createStatement()) {
            s.execute((engine == ScenarioEngine.SQLITE ? "DELETE FROM " : "TRUNCATE TABLE ") + q + "entries" + q);
            for (Map<String, Object> row : rows) {
                String cols = row.keySet().stream().map(k -> q + k + q).collect(Collectors.joining(", "));
                String vals = row.values().stream().map(DecimalOmdbApiContractLane::literal).collect(Collectors.joining(", "));
                s.execute("INSERT INTO " + q + "entries" + q + " (" + cols + ") VALUES (" + vals + ")");
            }
            switch (engine) {
                case POSTGRES -> s.execute("ALTER TABLE \"entries\" ALTER COLUMN \"id\" RESTART WITH " + next);
                case MYSQL -> s.execute("ALTER TABLE `entries` AUTO_INCREMENT = " + next);
                case SQLITE -> {
                    s.execute("DELETE FROM sqlite_sequence WHERE name = 'entries'");
                    s.execute("INSERT INTO sqlite_sequence (name, seq) VALUES ('entries', " + (next - 1) + ")");
                }
            }
        }
    }

    /** A seed value as a SQL literal; a decimal stays the text the file holds, never a double. */
    private static String literal(Object v) {
        if (v == null) return "NULL";
        if (v instanceof Boolean) return v.toString();   // TRUE/FALSE: valid on all three engines
        if (v instanceof Number) return v.toString();
        return "'" + v.toString().replace("'", "''") + "'";
    }

    private Connection connection() throws SQLException {
        return DriverManager.getConnection(target.jdbcUrl(), target.username(), target.password());
    }

    private DataSource dataSource() {
        return new DataSource() {
            @Override public Connection getConnection() throws SQLException { return connection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return connection(); }
            @Override public PrintWriter getLogWriter() { return null; }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int seconds) {}
            @Override public int getLoginTimeout() { return 0; }
            @Override public Logger getParentLogger() { return Logger.getLogger("integration-tests"); }
            @Override public <T> T unwrap(Class<T> iface) { return null; }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };
    }
}
