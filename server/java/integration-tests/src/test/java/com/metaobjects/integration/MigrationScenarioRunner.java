package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.MigrationExpect;
import com.metaobjects.integration.Scenarios.MigrationScenario;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.PostgresDriver;
import com.metaobjects.manager.db.migrate.AllowOptions;
import com.metaobjects.manager.db.migrate.Change;
import com.metaobjects.manager.db.migrate.DiffResult;
import com.metaobjects.manager.db.migrate.EmitResult;
import com.metaobjects.manager.db.migrate.SchemaMigrationEngine;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;

/**
 * Mirrors C# MigrationScenarioRunner / TS migration-scenario.ts:
 *
 *   1. Bootstrap the seed-metadata schema, if any.
 *   2. Execute the seed-data SQL.
 *   3. Diff target metadata against the live DB, capture emitted up SQL.
 *   4. Assert blocked + up-contains + up-empty.
 *   5. If apply-up-then-query is set: apply emitted SQL, run the post-query,
 *      assert normalized rows.
 *
 * Each call gets its own ObjectManagerDB + MetaDataLoaderRegistry so per-scenario
 * loaders don't leak across scenarios.
 */
public final class MigrationScenarioRunner {
    private MigrationScenarioRunner() {}

    public static void run(MigrationScenario s, PostgresContainer pg) throws Exception {
        // 1. Bootstrap the starting schema (if any).
        if (s.seedMetadataDir() != null) {
            applyFullCreate(pg, Paths.get(s.seedMetadataDir()), "seed-" + tag());
        }
        // 2. Seed data.
        if (s.seedData() != null && !s.seedData().isBlank()) {
            executeSql(pg, s.seedData());
        }

        // 3. Run diff + emit against the target metadata.
        Path targetDir = resolveTarget(s);
        MetaDataLoader targetLoader = MetaDataLoader.fromDirectory("target-" + tag(), targetDir);
        MetaDataLoaderRegistry registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        registry.registerLoader(targetLoader);

        ObjectManagerDB omdb = newOmdb(pg);
        SchemaMigrationEngine engine = new SchemaMigrationEngine(omdb, registry);

        try (Connection c = openConnection(pg)) {
            DiffResult diff = engine.diff(c, new AllowOptions());
            EmitResult emit = new EmitResult("", "");
            String up = "";
            if (diff.blocked().isEmpty()) {
                emit = engine.emit(c, new AllowOptions());
                up = emit.up();
            }

            // 4. Assertions.
            assertBlocked(s, diff.blocked());
            assertUpContains(s, up);
            assertUpEmpty(s, up);

            // 5. Apply + post-query.
            if (s.expect().applyUpThenQuery() != null && diff.blocked().isEmpty() && !up.isBlank()) {
                executeSql(c, up);
                List<Map<String, Object>> rows = queryRows(c, s.expect().applyUpThenQuery().sql());
                assertRows(s.sourcePath(), "apply-up-then-query", s.expect().applyUpThenQuery().rows(), rows);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Bootstrap (seed-metadata full-CREATE)
    // -----------------------------------------------------------------------

    private static void applyFullCreate(PostgresContainer pg, Path metadataDir, String tag) throws Exception {
        MetaDataLoader loader = MetaDataLoader.fromDirectory(tag, metadataDir);
        MetaDataLoaderRegistry registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        registry.registerLoader(loader);
        ObjectManagerDB omdb = newOmdb(pg);
        SchemaMigrationEngine engine = new SchemaMigrationEngine(omdb, registry);
        try (Connection c = openConnection(pg)) {
            EmitResult emit = engine.emit(c, new AllowOptions());
            executeSql(c, emit.up());
        }
    }

    private static Path resolveTarget(MigrationScenario s) throws Exception {
        if (s.targetMetadataDir() != null) return Paths.get(s.targetMetadataDir());
        if (s.targetMetadataInline() != null) {
            Path tmp = Files.createTempDirectory("metaobjects-scenario-");
            Files.writeString(tmp.resolve("meta.json"), s.targetMetadataInline());
            return tmp;
        }
        throw new IllegalStateException(s.sourcePath() + ": missing target-metadata / target-metadata-inline");
    }

    // -----------------------------------------------------------------------
    // ObjectManagerDB / JDBC plumbing
    // -----------------------------------------------------------------------

    private static ObjectManagerDB newOmdb(PostgresContainer pg) throws Exception {
        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new PostgresDriver());
        omdb.setDataSource(simpleDataSource(pg));
        omdb.init();
        return omdb;
    }

    private static DataSource simpleDataSource(PostgresContainer pg) {
        // Minimal DataSource — every getConnection() opens a fresh JDBC connection.
        // Engine + scenario both use short-lived connections; no pool needed.
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

    private static void executeSql(PostgresContainer pg, String sql) throws SQLException {
        try (Connection c = openConnection(pg)) { executeSql(c, sql); }
    }

    private static void executeSql(Connection c, String sql) throws SQLException {
        try (Statement s = c.createStatement()) { s.execute(sql); }
    }

    private static List<Map<String, Object>> queryRows(Connection c, String sql) throws SQLException {
        try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            ResultSetMetaData meta = rs.getMetaData();
            int n = meta.getColumnCount();
            List<Map<String, Object>> out = new ArrayList<>();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>(n);
                for (int i = 1; i <= n; i++) row.put(meta.getColumnLabel(i), rs.getObject(i));
                out.add(row);
            }
            return out;
        }
    }

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    private static void assertBlocked(MigrationScenario s, List<Change> actualBlocked) {
        MigrationExpect e = s.expect();
        if (e.blocked() == null || e.blocked().isEmpty()) {
            if (!actualBlocked.isEmpty())
                throw new AssertionError(s.sourcePath() + ": expected no blocked changes; got: " + formatBlocked(actualBlocked));
            return;
        }
        List<String> formatted = actualBlocked.stream().map(MigrationScenarioRunner::formatChange).toList();
        for (Scenarios.BlockedChange want : e.blocked()) {
            boolean hit = formatted.stream().anyMatch(b ->
                b.startsWith(want.kind()) && b.contains(want.reasonContains()));
            if (!hit) throw new AssertionError(
                s.sourcePath() + ": expected blocked change of kind '" + want.kind()
                + "' with reason containing '" + want.reasonContains() + "'; got: "
                + String.join("; ", formatted));
        }
    }

    private static void assertUpContains(MigrationScenario s, String up) {
        for (String needle : s.expect().upContains()) {
            if (!up.contains(needle))
                throw new AssertionError(
                    s.sourcePath() + ": up SQL did not contain expected substring '"
                    + needle + "'.\n--- up SQL ---\n" + up);
        }
    }

    private static void assertUpEmpty(MigrationScenario s, String up) {
        if (!Boolean.TRUE.equals(s.expect().upEmpty())) return;
        if (!up.isBlank())
            throw new AssertionError(s.sourcePath() + ": expected up-empty: true but got non-empty SQL:\n" + up);
    }

    private static void assertRows(
        String scenarioPath, String queryName,
        List<Map<String, Object>> expected, List<Map<String, Object>> actual) {
        String expectedJson = Normalization.canonicalRowsJson(expected);
        String actualJson   = Normalization.canonicalRowsJson(actual);
        if (!expectedJson.equals(actualJson)) {
            throw new AssertionError(
                scenarioPath + " / " + queryName + ": row mismatch.\n"
                + "  expected: " + expectedJson + "\n"
                + "  actual:   " + actualJson);
        }
    }

    private static String formatBlocked(List<Change> changes) {
        StringBuilder sb = new StringBuilder();
        for (Change c : changes) sb.append(formatChange(c)).append("; ");
        return sb.toString();
    }

    /**
     * Format a Change to the cross-port "kind: reason" assertion vocabulary.
     * Java record names are already PascalCase ("DropTable"), matching C#.
     */
    private static String formatChange(Change c) {
        String kind = c.getClass().getSimpleName();
        String reason = "";
        if (c instanceof Change.DropTable d) reason = nullSafe(d.status().blockedReason());
        else if (c instanceof Change.DropColumn d) reason = nullSafe(d.status().blockedReason());
        else if (c instanceof Change.DropIndex d) reason = nullSafe(d.status().blockedReason());
        else if (c instanceof Change.DropFk d) reason = nullSafe(d.status().blockedReason());
        else if (c instanceof Change.ChangeColumnType d) reason = nullSafe(d.status().blockedReason());
        return kind + ": " + reason;
    }

    private static String nullSafe(String s) { return s == null ? "" : s; }

    private static String tag() { return UUID.randomUUID().toString().substring(0, 8); }
}
