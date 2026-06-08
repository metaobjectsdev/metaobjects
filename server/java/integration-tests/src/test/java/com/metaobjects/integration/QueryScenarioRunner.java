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
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.LinkedHashMap;
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
        // Per-entity actual SQL column types, probed once from the catalog. OMDB
        // collapses a column to its field-subtype Java type (losing INTEGER vs
        // BIGINT), but the canonical wire shape is driven by the real column type
        // — see ObjectManagerDbAdapter.coerceWireType.
        Map<MetaObject, Map<String, Integer>> columnTypeCache = new HashMap<>();
        try {
            for (QuerySpec spec : scenario.queries()) {
                MetaObject mc = findEntityByShortName(loader, spec.entity());
                if (mc == null) throw new AssertionError(
                    scenario.sourcePath() + " / " + spec.name() +
                    ": no MetaObject named '" + spec.entity() + "' in canonical loader");
                Map<String, Integer> columnSqlTypes = columnTypeCache.computeIfAbsent(
                    mc, m -> probeColumnSqlTypes(pg, m));
                // op:relate normalizes the TARGET entity's rows, so the adapter needs
                // to probe column types for an entity other than `mc`; hand it a probe
                // that hits the same per-scenario cache.
                ObjectManagerDbAdapter.ColumnTypeProbe probe =
                    m -> columnTypeCache.computeIfAbsent(m, x -> probeColumnSqlTypes(pg, x));

                // FR-017 TPH: an `expect-error: true` op (a cross-subtype write rejection) MUST
                // throw — any exception/assertion from the dispatch counts as the expected error.
                if (spec.expectError()) {
                    boolean threw = false;
                    try { dispatch(omdb, oc, mc, spec, columnSqlTypes, loader, probe); }
                    catch (Exception | AssertionError e) { threw = true; }
                    if (!threw) throw new AssertionError(scenario.sourcePath() + " / " + spec.name()
                        + ": expected the op to be rejected (expect-error) but it succeeded");
                    continue;
                }

                Object actual = dispatch(omdb, oc, mc, spec, columnSqlTypes, loader, probe);
                assertResult(scenario.sourcePath(), spec, actual);
            }
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    /**
     * Dispatch one {@link QuerySpec} to the runtime write/read path and return its normalized
     * result. {@code op:roundtrip} INSERTs via {@link RoundtripWriter} (read back by PK, PK
     * dropped); every other op goes through {@link ObjectManagerDbAdapter}. Shared by the normal
     * and {@code expect-error} arms of the scenario loop.
     */
    private static Object dispatch(ObjectManagerDB omdb, ObjectConnection oc, MetaObject mc,
                                   QuerySpec spec, Map<String, Integer> columnSqlTypes,
                                   MetaDataLoader loader, ObjectManagerDbAdapter.ColumnTypeProbe probe)
            throws Exception {
        // op:roundtrip — INSERT via the OMDB write path, read back by PK, drop the PK,
        // assert the normalized read-back == `expect` (the WRITE codec + read gate).
        if ("roundtrip".equals(spec.op())) {
            return RoundtripWriter.execute(omdb, oc, mc, spec, columnSqlTypes);
        }
        return ObjectManagerDbAdapter.execute(omdb, oc, mc, spec, columnSqlTypes, loader.getRoot(), probe);
    }

    /**
     * Probe the actual JDBC column type ({@link java.sql.Types}) of each column on
     * the entity's primary physical relation (table or view), keyed by column name.
     * The corpus declares no {@code @column} renames, so a column name equals its
     * {@code field.*} name; {@link ObjectManagerDbAdapter} keys the result by field
     * name. A {@code SELECT * ... WHERE 1=0} returns no rows but a fully-typed
     * {@link ResultSetMetaData}. Returns an empty map for a non-persistent object.
     */
    private static Map<String, Integer> probeColumnSqlTypes(PostgresContainer pg, MetaObject mc) {
        String relation = mc.getPrimaryRdbViewName();
        if (relation == null) relation = mc.getPrimaryRdbTableName();
        if (relation == null) return Map.of();
        Map<String, Integer> types = new LinkedHashMap<>();
        String sql = "SELECT * FROM \"" + relation + "\" WHERE 1=0";
        try (Connection c = openConnection(pg);
             Statement s = c.createStatement();
             ResultSet rs = s.executeQuery(sql)) {
            ResultSetMetaData md = rs.getMetaData();
            for (int i = 1; i <= md.getColumnCount(); i++) {
                types.put(md.getColumnName(i), md.getColumnType(i));
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to probe column types for relation '" + relation + "'", e);
        }
        return types;
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
        // op:delete asserts a boolean (true = a row was deleted).
        if ("delete".equals(op)) return Boolean.toString(asBoolean(expect));
        // op:relate is an ORDER-INDEPENDENT set (M:N navigation) — sort both sides.
        if ("relate".equals(op)) {
            if (expect == null) return "[]";
            return Normalization.canonicalRowSet((List<Map<String, Object>>) expect);
        }
        // op:get / op:roundtrip / op:create / op:update each assert a single bare object (roundtrip
        // drops the PK; get + create + update retain it).
        if (isSingleObjectOp(op)) {
            if (expect == null) return "null";
            return Normalization.canonicalRowsJson(List.of((Map<String, Object>) expect))
                // canonicalRowsJson always wraps in [...]; the single-object path expects the bare object.
                .replaceAll("^\\[", "").replaceAll("\\]$", "");
        }
        // op:list
        if (expect == null) return "[]";
        return Normalization.canonicalRowsJson((List<Map<String, Object>>) expect);
    }

    @SuppressWarnings("unchecked")
    private static String canonicalizeActual(Object actual, String op) {
        if ("count".equals(op)) return Long.toString(actual instanceof Number n ? n.longValue() : 0L);
        if ("delete".equals(op)) return Boolean.toString(asBoolean(actual));
        if ("relate".equals(op)) {
            if (actual == null) return "[]";
            return Normalization.canonicalRowSet((List<Map<String, Object>>) actual);
        }
        if (actual == null) return "null";
        if (isSingleObjectOp(op)) {
            return Normalization.canonicalRowsJson(List.of((Map<String, Object>) actual))
                .replaceAll("^\\[", "").replaceAll("\\]$", "");
        }
        return Normalization.canonicalRowsJson((List<Map<String, Object>>) actual);
    }

    /** Single-bare-object ops: a read-by-PK ({@code get}), a write-then-read ({@code roundtrip} / {@code create} / {@code update}). */
    private static boolean isSingleObjectOp(String op) {
        return "get".equals(op) || "roundtrip".equals(op) || "create".equals(op) || "update".equals(op);
    }

    private static boolean asBoolean(Object v) {
        if (v instanceof Boolean b) return b;
        return Boolean.parseBoolean(String.valueOf(v));
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
