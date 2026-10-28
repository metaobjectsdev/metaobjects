package com.metaobjects.integration.api;

import com.metaobjects.integration.JdbcTarget;
import com.metaobjects.integration.QueryScenarioRunner;
import com.metaobjects.integration.ScenarioEngine;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedReportControllerHarness;
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
import java.nio.file.Path;
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
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * FR-044 — the Java full-stack lane of the view-backed-report api-contract sub-corpus, on a real
 * database. One subclass per engine. The artifacts under test are the GENERATED
 * {@code <Report>Controller} / DTO / allowlist / {@code <Report>Repository} interface, mounted
 * unmodified on embedded Tomcat; the adopter-owned repository seam is an OMDB-backed
 * implementation ({@code OmdbReportRepositorySource}) that reads each report's view through
 * {@code ObjectManagerDB} and the report read model.
 *
 * <p>The database executes the committed TypeScript-produced {@code report/schema.<engine>.sql}
 * verbatim (no port writes view SQL, ADR-0015), the base tables are seeded from the base-table
 * half of {@code report/seed.json}, and the real views derive the rows, exactly as the
 * TypeScript and C# lanes do. Every scenario is a read (or a rejected write), so one database
 * and one server serve the whole corpus.</p>
 *
 * <p>Generated lane ONLY, on purpose and on every port (see the sub-corpus README): what is
 * under test is whether the port's GENERATOR emits a read route for a served report and nothing
 * for a sourceless one. The default page size stays 50 in Java; the scenarios that page pass
 * {@code limit} explicitly.</p>
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
abstract class ReportOmdbApiContractLane {

    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(ReportCorpus.scenariosDir());

    private GeneratedReportControllerHarness harness;
    private JdbcTarget target;

    /** The engine this subclass runs on. */
    abstract ScenarioEngine engine();

    /** Start (or open) the engine's throwaway database. */
    abstract JdbcTarget openDatabase();

    /** Release what {@link #openDatabase()} started. */
    abstract void closeDatabase();

    @BeforeAll
    void setUp() throws Exception {
        target = openDatabase();
        provision(engine(), target);

        Path genDir = Files.createTempDirectory("report-omdb-controllers");
        harness = new GeneratedReportControllerHarness(
            ReportCorpus.root(), genDir, ReportCorpus.SERVED, ReportCorpus.SOURCELESS);

        // The report read model's rows are generic value objects; bind every entity of the model.
        ObjectClassRegistry reg = new ObjectClassRegistry();
        Map<String, Class<?>> bindings = new HashMap<>();
        for (String entity : List.of("Invoice", "Category", "Product", "Sale", "Ticket", "Reading", "ExportLine")) {
            bindings.put("acme::sales::" + entity, ValueObject.class);
        }
        reg.register(() -> bindings);
        ObjectClassRegistry.setGlobal(reg);

        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(engine().newDriver());
        omdb.setDataSource(dataSource(target));
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

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @Test
    void theCorpusCarriesItsScenarios() throws Exception {
        // A scenarios directory that resolved to nothing would leave this lane green and empty;
        // the count is the files on disk, so a scenario the loader dropped fails here.
        try (Stream<Path> files = Files.list(ReportCorpus.scenariosDir())) {
            assertEquals(files.filter(p -> p.toString().endsWith(".yaml")).count(), SCENARIOS.size());
        }
        org.junit.jupiter.api.Assertions.assertTrue(SCENARIOS.size() > 0);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String name, ApiScenario scenario) {
        assertDoesNotThrow(() -> {
            for (ApiRequest req : scenario.requests()) {
                GeneratedReportControllerHarness.Response res =
                    harness.exchange(req.method(), req.path(), req.body(), req.headers());
                Object parsed = harness.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed,
                    res.body(), res.headers());
            }
        });
    }

    // -----------------------------------------------------------------------
    // database provisioning
    // -----------------------------------------------------------------------

    /** Execute the engine's schema artifact verbatim, then insert the base-table seed, parents first. */
    private static void provision(ScenarioEngine engine, JdbcTarget target) throws SQLException {
        String schema = ReportCorpus.schema(engine.schemaArtifact().replace("canonical/schema.", "").replace(".sql", ""));
        try (Connection c = DriverManager.getConnection(target.jdbcUrl(), target.username(), target.password())) {
            if (engine == ScenarioEngine.POSTGRES) {
                try (Statement s = c.createStatement()) { s.execute(schema); }
            } else {
                List<String> statements = ScenarioEngine.splitStatements(schema);
                // A MySQL server may be an existing shared database: start from an empty schema.
                if (engine == ScenarioEngine.MYSQL) QueryScenarioRunner.dropSchema(c, statements);
                try (Statement s = c.createStatement()) {
                    for (String stmt : statements) s.execute(stmt);
                }
            }
            String q = engine.quote();
            try (Statement s = c.createStatement()) {
                for (Map.Entry<String, List<Map<String, Object>>> table : ReportCorpus.baseTables().entrySet()) {
                    for (Map<String, Object> row : table.getValue()) {
                        String cols = row.keySet().stream().map(k -> q + k + q).collect(Collectors.joining(", "));
                        String vals = row.values().stream().map(ReportOmdbApiContractLane::literal).collect(Collectors.joining(", "));
                        s.execute("INSERT INTO " + q + table.getKey() + q + " (" + cols + ") VALUES (" + vals + ")");
                    }
                }
            }
        }
    }

    /** A seed value as a SQL literal; the fixture is trusted, and an untyped literal binds to any column type. */
    private static String literal(Object v) {
        if (v == null) return "NULL";
        if (v instanceof Boolean || v instanceof Number) return v.toString();
        return "'" + v.toString().replace("'", "''") + "'";
    }

    private static DataSource dataSource(JdbcTarget target) {
        return new DataSource() {
            @Override public Connection getConnection() throws SQLException {
                return DriverManager.getConnection(target.jdbcUrl(), target.username(), target.password());
            }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
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
