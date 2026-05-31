package com.metaobjects.integration;

import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.PostgresDriver;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Collection;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SP-D Unit 4 — runtime return-type gate (Java port).
 *
 * <p>Pins ADR-0019: the OMDB {@link ObjectManagerDB} runtime returns NATIVE,
 * in-process Java types from its query path — NOT canonicalized wire-strings.
 * Wire canonicalization (BIGINT→string, NUMERIC→no-trailing-zero string,
 * temporal→normalization.md forms, jsonb→key-sorted) is a boundary concern
 * applied only at the test-harness {@code Normalization} seam, never inside the
 * runtime. This test reads the value OMDB loaded onto a {@link ValueObject}
 * BEFORE any normalization runs and asserts each is its native Java type:</p>
 *
 * <ul>
 *   <li>integer field ({@code Measurement.id}) → {@link Integer} / {@link Long}
 *       (a native integer, never a {@link String}).</li>
 *   <li>{@code Measurement.preciseKg} (NUMERIC(9,4)) → {@link BigDecimal} (exact;
 *       SP-D Unit 2 backed {@code DecimalField} with {@code DataTypes.DECIMAL}).</li>
 *   <li>{@code Asset.recordedAt} (TIMESTAMPTZ) → a native temporal
 *       ({@link java.util.Date} / {@link java.sql.Timestamp}), never a {@link String}.</li>
 *   <li>{@code Asset.payload} (jsonb) → OMDB reads the jsonb column as raw JSON
 *       text ({@link String}); the parse-to-map step is a harness concern. We assert
 *       what the runtime genuinely returns and document it (see the test body).</li>
 * </ul>
 *
 * <p>This is a per-port gate (native types differ per language), not a
 * byte-identical cross-port corpus. It catches the Python-outlier class of
 * regression — a runtime that bakes wire-strings into its query path.</p>
 *
 * <p>NOT part of the default Maven reactor build — run via
 * {@code mvn -f server/java/integration-tests/pom.xml test} or
 * {@code scripts/integration-test.sh java}.</p>
 */
final class RuntimeReturnTypeTest {

    private static final Path CORPUS = ScenarioLoader.findCorpusRoot();
    private static final Path CANONICAL = CORPUS.resolve("canonical");

    @BeforeAll
    static void beforeAll() {
        // Match QueryScenarioTests: pin the JVM zone to UTC (TIMESTAMP fixtures are
        // UTC-canonical) and bind canonical entities to ValueObject so OMDB can
        // instantiate rows without a project POJO.
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"));
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of(
            "fitness::Program",     ValueObject.class,
            "fitness::Week",        ValueObject.class,
            "fitness::Measurement", ValueObject.class,
            "fitness::Asset",       ValueObject.class,
            "fitness::ProgramView", ValueObject.class,
            "fitness::ProgramStat", ValueObject.class
        ));
        ObjectClassRegistry.setGlobal(reg);
    }

    @Test
    void runtimeReturnsNativeTypesNotWireStrings() throws Exception {
        try (PostgresContainer pg = new PostgresContainer()) {
            String tag = "runtime-types-" + UUID.randomUUID().toString().substring(0, 8);
            MetaDataLoader loader = MetaDataLoader.fromDirectory(tag, CANONICAL);

            ObjectManagerDB omdb = new ObjectManagerDB();
            omdb.setDatabaseDriver(new PostgresDriver());
            omdb.setDataSource(simpleDataSource(pg));
            omdb.init();

            // Provision schema from the committed canonical DDL (ADR-0015) + seed one
            // Measurement and one Asset row.
            String schemaDdl = ScenarioLoader.readCanonicalSchema(CORPUS);
            try (Connection c = openConnection(pg)) {
                executeSql(c, schemaDdl);
                executeSql(c, """
                    INSERT INTO "measurements" ("id","tempC","massKg","preciseKg")
                    VALUES (1, 1.5, 0.125, 12.5000);
                    """);
                executeSql(c, """
                    INSERT INTO "assets"
                      ("id","ownerId","externalId","payload","recordedAt","observedAt","asOfDate","atTime")
                    VALUES
                      ('11111111-1111-4111-8111-111111111111',
                       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                       '22222222-2222-4222-8222-222222222222',
                       '{"b": 2, "a": 1}',
                       '2026-05-30T14:30:00.123Z', '2026-05-30T14:30:00.123', '2026-05-30', '14:30:00.123');
                    """);
            }

            ObjectConnection oc = omdb.getConnection();
            try {
                // --- Measurement: native integer + native exact decimal ---------------
                MetaObject measurement = findEntity(loader, "Measurement");
                ValueObject m = queryOne(omdb, oc, measurement, "id", 1);

                Object id = m.get(fieldName(measurement, "id"));
                assertNotNull(id, "Measurement.id should be present");
                assertTrue(id instanceof Integer || id instanceof Long,
                    "field.int Measurement.id must be a native integer (Integer/Long), got: "
                        + id.getClass().getName() + " (wire-string regression?)");

                Object preciseKg = m.get(fieldName(measurement, "preciseKg"));
                assertInstanceOf(BigDecimal.class, preciseKg,
                    "field.decimal Measurement.preciseKg must be a native exact BigDecimal "
                        + "(SP-D Unit 2 / ADR-0019), got: "
                        + (preciseKg == null ? "null" : preciseKg.getClass().getName()));

                // --- Asset: native temporal + native jsonb representation -------------
                MetaObject asset = findEntity(loader, "Asset");
                ValueObject a = queryOne(omdb, oc, asset, "id", "11111111-1111-4111-8111-111111111111");

                Object recordedAt = a.get(fieldName(asset, "recordedAt"));
                assertNotNull(recordedAt, "Asset.recordedAt should be present");
                assertInstanceOf(java.util.Date.class, recordedAt,
                    "field.timestamp Asset.recordedAt (TIMESTAMPTZ) must be a native temporal "
                        + "(java.util.Date / java.sql.Timestamp), NOT a String. Got: "
                        + recordedAt.getClass().getName());
                assertTrue(!(recordedAt instanceof String),
                    "Asset.recordedAt must not be a wire-string");

                // jsonb: OMDB reads a @dbColumnType:jsonb column as raw JSON text (String).
                // The parse-to-Map step is a harness concern (ObjectManagerDbAdapter.maybeParseJson),
                // NOT baked into the runtime. We assert the runtime's genuine native return
                // (a String of JSON), documenting that canonicalization (key-sorting) happens
                // at the boundary. The contract this pins: the runtime does not pre-canonicalize
                // (key-sort) — the bytes are the stored JSON, parsed/sorted only at the seam.
                Object payload = a.get(fieldName(asset, "payload"));
                assertNotNull(payload, "Asset.payload should be present");
                assertInstanceOf(String.class, payload,
                    "Asset.payload (jsonb) is surfaced by OMDB as raw JSON text; got: "
                        + payload.getClass().getName());
            } finally {
                omdb.releaseConnection(oc);
            }
        }
    }

    // -----------------------------------------------------------------------

    private static ValueObject queryOne(ObjectManagerDB omdb, ObjectConnection oc,
                                        MetaObject mc, String field, Object value) throws Exception {
        QueryOptions opts = new QueryOptions();
        opts.setExpression(new Expression(field, value, Expression.EQUAL));
        Collection<?> rows = omdb.getObjects(oc, mc, opts);
        assertTrue(!rows.isEmpty(), "expected a seeded " + mc.getShortName() + " row for " + field + "=" + value);
        Object first = rows.iterator().next();
        return assertInstanceOf(ValueObject.class, first,
            mc.getShortName() + " runtime row should be a ValueObject");
    }

    private static MetaObject findEntity(MetaDataLoader loader, String shortName) {
        for (MetaObject mc : loader.getMetaObjects()) {
            if (mc.getShortName().equals(shortName)) return mc;
        }
        throw new AssertionError("no MetaObject named '" + shortName + "' in canonical loader");
    }

    private static String fieldName(MetaObject mc, String name) {
        for (MetaField<?> mf : mc.getMetaFields()) {
            if (mf.getName().equals(name)) return mf.getName();
        }
        throw new AssertionError("no field '" + name + "' on " + mc.getShortName());
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
