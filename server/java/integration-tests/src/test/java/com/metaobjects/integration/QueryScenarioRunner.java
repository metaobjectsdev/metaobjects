package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.QueryScenario;
import com.metaobjects.integration.Scenarios.QuerySpec;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.PostgresDriver;
import com.metaobjects.object.MetaObject;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;

/**
 * Mirrors C# QueryScenarioRunner / TS query-scenario.ts. End-to-end:
 *
 *   1. Provision the schema by executing the committed canonical DDL
 *      ({@code fixtures/persistence-conformance/canonical/schema.postgres.sql})
 *      verbatim on a direct JDBC connection. Schema authority is the
 *      TS-produced artifact (ADR-0015); the Java port no longer derives the
 *      conformance schema from metadata at test time. The committed DDL is the
 *      sole schema source — OMDB's runtime auto-create is NOT engaged here, so
 *      this exercises OMDB's native uuid/jsonb/timestamptz runtime read against
 *      a TS-authored schema.
 *   2. Execute the scenario's seed-data SQL.
 *   3. For each {@link QuerySpec}: translate via {@link ObjectManagerDbAdapter}
 *      → {@link ObjectManagerDB#getObjects} / {@code getObjectsCount},
 *      normalize the result, compare against the expect block.
 */
public final class QueryScenarioRunner {
    private QueryScenarioRunner() {}

    public static void run(QueryScenario scenario, PostgresContainer pg, Path canonicalDir) throws Exception {
        // Pick a canonical-loader name unique per scenario so registry state
        // from a previous scenario doesn't leak across containers.
        String tag = "canonical-" + UUID.randomUUID().toString().substring(0, 8);
        MetaDataLoader loader = MetaDataLoader.fromDirectory(tag, canonicalDir);

        ObjectManagerDB omdb = newOmdb(pg);

        // 1. Provision the schema by executing the committed canonical DDL
        //    verbatim — the TS-produced artifact is the sole schema source
        //    (ADR-0015). OMDB's runtime auto-create is intentionally NOT engaged.
        String schemaDdl = ScenarioLoader.readCanonicalSchema(canonicalDir.getParent());
        try (Connection c = openConnection(pg)) { executeSql(c, schemaDdl); }

        // 2. Seed data.
        if (scenario.seedData() != null && !scenario.seedData().isBlank()) {
            try (Connection c = openConnection(pg)) { executeSql(c, scenario.seedData()); }
        }

        // 3. Run queries.
        ObjectConnection oc = omdb.getConnection();
        try {
            for (QuerySpec spec : scenario.queries()) {
                MetaObject mc = findEntityByShortName(loader, spec.entity());
                if (mc == null) throw new AssertionError(
                    scenario.sourcePath() + " / " + spec.name() +
                    ": no MetaObject named '" + spec.entity() + "' in canonical loader");
                Object actual = ObjectManagerDbAdapter.execute(omdb, oc, mc, spec);
                assertResult(scenario.sourcePath(), spec, actual);
            }
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    /**
     * Walk the loader's MetaObjects looking for a match by bare name. The
     * cross-port corpus references entities by short name ("Program",
     * "Week"); the loader stores them by FQN ("fitness::Program") so a
     * direct {@code getMetaObjectByName} lookup misses.
     */
    private static MetaObject findEntityByShortName(MetaDataLoader loader, String shortName) {
        for (MetaObject mc : loader.getMetaObjects()) {
            if (mc.getShortName().equals(shortName)) return mc;
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    private static void assertResult(String scenarioPath, QuerySpec spec, Object actual) {
        String expectedJson = canonicalizeExpected(spec.expect(), spec.op());
        String actualJson = canonicalizeActual(actual, spec.op());
        if (!expectedJson.equals(actualJson)) {
            throw new AssertionError(
                scenarioPath + " / " + spec.name() + ": result mismatch\n"
                + "  expected: " + expectedJson + "\n"
                + "  actual:   " + actualJson);
        }
    }

    @SuppressWarnings("unchecked")
    private static String canonicalizeExpected(Object expect, String op) {
        if ("count".equals(op)) {
            long n = expect instanceof Number num ? num.longValue()
                : Long.parseLong(String.valueOf(expect));
            return Long.toString(n);
        }
        if ("get".equals(op)) {
            if (expect == null) return "null";
            return Normalization.canonicalRowsJson(List.of((Map<String, Object>) expect))
                // canonicalRowsJson always wraps in [...]; the get path expects the bare object.
                .replaceAll("^\\[", "").replaceAll("\\]$", "");
        }
        // op:list
        if (expect == null) return "[]";
        return Normalization.canonicalRowsJson((List<Map<String, Object>>) expect);
    }

    @SuppressWarnings("unchecked")
    private static String canonicalizeActual(Object actual, String op) {
        if ("count".equals(op)) return Long.toString(actual instanceof Number n ? n.longValue() : 0L);
        if (actual == null) return "null";
        if ("get".equals(op)) {
            return Normalization.canonicalRowsJson(List.of((Map<String, Object>) actual))
                .replaceAll("^\\[", "").replaceAll("\\]$", "");
        }
        return Normalization.canonicalRowsJson((List<Map<String, Object>>) actual);
    }

    // -----------------------------------------------------------------------
    // Postgres + ObjectManagerDB plumbing
    // -----------------------------------------------------------------------

    private static ObjectManagerDB newOmdb(PostgresContainer pg) throws Exception {
        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new PostgresDriver());
        omdb.setDataSource(simpleDataSource(pg));
        omdb.init();
        return omdb;
    }

    private static DataSource simpleDataSource(PostgresContainer pg) {
        return new DataSource() {
            @Override public Connection getConnection() throws SQLException { return openConnection(pg); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return openConnection(pg); }
            @Override public PrintWriter getLogWriter() { return null; }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int seconds) {}
            @Override public int getLoginTimeout() { return 0; }
            @Override public Logger getParentLogger() { return Logger.getLogger("integration-tests"); }
            @Override public <T> T unwrap(Class<T> iface) { return null; }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };
    }

    private static Connection openConnection(PostgresContainer pg) throws SQLException {
        return DriverManager.getConnection(pg.jdbcUrl(), pg.username(), pg.password());
    }

    private static void executeSql(Connection c, String sql) throws SQLException {
        try (Statement s = c.createStatement()) { s.execute(sql); }
    }
}
