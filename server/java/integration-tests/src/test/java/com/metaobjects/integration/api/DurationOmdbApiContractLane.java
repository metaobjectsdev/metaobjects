package com.metaobjects.integration.api;

import com.metaobjects.integration.JdbcTarget;
import com.metaobjects.integration.QueryScenarioRunner;
import com.metaobjects.integration.ScenarioEngine;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedDurationControllerHarness;
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
 * The Java full-stack lane of the {@code duration/} api-contract sub-corpus on a real database; one
 * subclass per engine. The artifacts under test are the GENERATED {@code TimerController}, DTO,
 * allowlist and repository interface, mounted unmodified on embedded Tomcat over an OMDB-backed
 * repository. The database executes the committed {@code duration/schema.<engine>.sql} verbatim;
 * {@code timers} is emptied and its counter reset before EVERY scenario (the scenarios write).
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
abstract class DurationOmdbApiContractLane {

    private final List<ApiScenario> scenarios = ApiContractScenarioLoader.loadScenarios(DurationCorpus.scenariosDir());

    private GeneratedDurationControllerHarness harness;
    private JdbcTarget target;

    abstract ScenarioEngine engine();

    abstract JdbcTarget openDatabase();

    abstract void closeDatabase();

    @BeforeAll
    void setUp() throws Exception {
        target = openDatabase();
        provisionSchema();

        harness = new GeneratedDurationControllerHarness(DurationCorpus.root(), Files.createTempDirectory("duration-omdb-controllers"));

        ObjectClassRegistry reg = new ObjectClassRegistry();
        Map<String, Class<?>> bindings = new HashMap<>();
        bindings.put("acme::ops::Timer", ValueObject.class);
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
    void theEngineRunsAtLeastOneScenario() {
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
                GeneratedDurationControllerHarness.Response res =
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
        String schema = DurationCorpus.schema(engine.id());
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

    /** Empty {@code timers} and restart its id counter, so the first POST of a scenario is id 1. */
    private void reseed() throws SQLException {
        ScenarioEngine engine = engine();
        String q = engine.quote();
        try (Connection c = connection(); Statement s = c.createStatement()) {
            s.execute((engine == ScenarioEngine.SQLITE ? "DELETE FROM " : "TRUNCATE TABLE ") + q + "timers" + q);
            switch (engine) {
                case POSTGRES -> s.execute("ALTER TABLE \"timers\" ALTER COLUMN \"id\" RESTART WITH 1");
                case MYSQL -> s.execute("ALTER TABLE `timers` AUTO_INCREMENT = 1");
                case SQLITE -> s.execute("DELETE FROM sqlite_sequence WHERE name = 'timers'");
            }
        }
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
