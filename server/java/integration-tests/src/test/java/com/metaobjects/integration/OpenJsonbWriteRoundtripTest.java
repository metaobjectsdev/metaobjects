package com.metaobjects.integration;

import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Mandate 1 (#98) — the OMDB runtime WRITE gate for an <em>open-JSON-bag</em>
 * column ({@code field.string @dbColumnType:jsonb}).
 *
 * <p><b>Why this test exists.</b> The cross-port jsonb-open-bag contract (#98)
 * is that the field exposes a <em>parsed</em> JSON value. The persistence corpus
 * proved the READ side ({@code asset-uuid-roundtrip.yaml} seeds {@code payload}
 * via raw SQL and reads it back parsed) and the typed {@code @storage:jsonb}
 * WRITE side ({@code roundtrip-all-types.yaml} writes a {@code Settings}
 * value-object), but no scenario exercised the <em>open</em>
 * {@code @dbColumnType:jsonb} bag through OMDB's runtime write codec. This test
 * fills that gap: it INSERTs an {@code Asset} via
 * {@link ObjectManagerDB#createObject} (NOT raw SQL) and reads it back.</p>
 *
 * <p><b>OMDB's open-bag contract is JSON text.</b> OMDB's {@code ValueObject}
 * model is statically typed by field subtype (ADR-0017): a {@code field.string}
 * holds a {@code String}. The open bag is therefore authored as JSON
 * <em>text</em> — exactly how the asset-uuid seed and the LLM-trace recorder
 * store it — and OMDB's write path serializes/binds it faithfully through
 * {@code isOpenJsonbField} → {@code serializeOpenJsonb} → {@code bindJsonbParameter}
 * (Postgres {@code setObject(.., Types.OTHER)} — a bare {@code setString} is
 * rejected by jsonb's strict input typing). The "post an OBJECT" half of the
 * cross-port contract lives at the DTO/serialization boundary (the generated DTO
 * is {@code Object}, #103): a consumer serializes the posted object to JSON text
 * before it reaches OMDB's {@code field.string}, and the read side re-parses it.
 * (Assigning a raw {@code Map} to a {@code field.string} is coerced to its java
 * {@code toString()} at set-time by the generic field-typing in
 * {@code DataObjectBase}, identical for every string field — not a jsonb
 * write-path defect, and out of scope to change here.)</p>
 *
 * <p>Postgres-only (Testcontainers). Not part of the default Maven reactor —
 * run via {@code mvn -f server/java/integration-tests/pom.xml test}.</p>
 */
final class OpenJsonbWriteRoundtripTest {

    private static final Path CORPUS = ScenarioLoader.findCorpusRoot();
    private static final Path CANONICAL = CORPUS.resolve("canonical");
    private static final ObjectMapper JSON = new ObjectMapper();

    @BeforeAll
    static void bindEntities() {
        // Bind Asset to ValueObject so OMDB can instantiate rows without a
        // project POJO (mirrors QueryScenarioTests.beforeAll). Skip if a prior
        // test class in the same JVM already published a registry with Asset.
        if (ObjectClassRegistry.global().resolve("fitness::Asset") != null) return;
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of("fitness::Asset", ValueObject.class));
        ObjectClassRegistry.setGlobal(reg);
    }

    /**
     * A JSON value written into the open bag through the OMDB runtime write
     * codec ({@code createObject}, NOT raw SQL) reads back as the same parsed
     * structure — including a nested object and an array — never a malformed or
     * double-encoded blob. This is the WRITE complement to the read-only
     * {@code asset-uuid-roundtrip} scenario.
     */
    @Test
    void openBagJsonValueRoundTripsThroughOmdbWrite() throws Exception {
        String payloadJson = "{\"k\":\"v\",\"n\":7,\"nested\":{\"deep\":true},\"list\":[1,2,3]}";

        try (PostgresContainer pg = new PostgresContainer()) {
            MetaDataLoader loader = MetaDataLoader.fromDirectory(
                "open-jsonb-" + UUID.randomUUID().toString().substring(0, 8), CANONICAL);
            ObjectManagerDB omdb = newOmdb(pg);
            provisionSchema(pg);

            MetaObject asset = findByShortName(loader, "Asset");
            assertNotNull(asset, "canonical loader must contain Asset");

            ValueObject vo = (ValueObject) asset.newInstance();
            vo.setString("ownerId", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
            vo.setString("payload", payloadJson); // open bag = JSON text
            vo.setDate("recordedAt", instant("2026-05-30T14:30:00Z"));
            vo.setDate("observedAt", instant("2026-05-30T14:30:00Z"));
            vo.setDate("asOfDate", java.util.Date.from(
                LocalDate.parse("2026-05-30").atStartOfDay(ZoneOffset.UTC).toInstant()));
            vo.setObject("atTime", LocalTime.parse("14:30:00"));

            ObjectConnection oc = omdb.getConnection();
            try {
                omdb.createObject(oc, vo); // INSERT via the OMDB runtime write path
                Object id = vo.get("id");  // app-side minted uuid PK
                assertNotNull(id, "OMDB should mint the uuid PK on insert");

                Collection<?> rows = omdb.getObjects(oc, asset,
                    new QueryOptions(new Expression("id", id, Expression.EQUAL)));
                assertEquals(1, rows.size(), "inserted row must read back");
                ValueObject readBack = (ValueObject) rows.iterator().next();

                // OMDB returns the jsonb column as raw JSON text. Parse + compare
                // structurally — a malformed or double-encoded value fails to
                // parse back to the original tree.
                Object raw = readBack.get("payload");
                assertNotNull(raw, "payload must read back");
                assertEquals(JSON.readTree(payloadJson),
                             JSON.readTree(String.valueOf(raw)),
                             "open-bag jsonb value must round-trip through OMDB write+read parsed");
            } finally {
                omdb.releaseConnection(oc);
            }
        }
    }

    // -----------------------------------------------------------------------
    // OMDB + Postgres plumbing (mirrors QueryScenarioRunner)
    // -----------------------------------------------------------------------

    private static ObjectManagerDB newOmdb(PostgresContainer pg) throws Exception {
        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new PostgresDriver());
        omdb.setDataSource(dataSource(pg));
        omdb.init();
        return omdb;
    }

    private static void provisionSchema(PostgresContainer pg) throws Exception {
        String ddl = ScenarioLoader.readCanonicalSchema(CORPUS);
        try (Connection c = openConnection(pg); Statement s = c.createStatement()) {
            s.execute(ddl);
        }
    }

    private static MetaObject findByShortName(MetaDataLoader loader, String shortName) {
        for (MetaObject mc : loader.getMetaObjects()) {
            if (mc.getShortName().equals(shortName)) return mc;
        }
        return null;
    }

    private static java.util.Date instant(String iso) {
        return java.util.Date.from(java.time.Instant.parse(iso));
    }

    private static Connection openConnection(PostgresContainer pg) throws SQLException {
        return DriverManager.getConnection(pg.jdbcUrl(), pg.username(), pg.password());
    }

    private static DataSource dataSource(PostgresContainer pg) {
        return new DataSource() {
            @Override public Connection getConnection() throws SQLException { return openConnection(pg); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return openConnection(pg); }
            @Override public PrintWriter getLogWriter() { return null; }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int seconds) {}
            @Override public int getLoginTimeout() { return 0; }
            @Override public Logger getParentLogger() { return Logger.getLogger("open-jsonb-test"); }
            @Override public <T> T unwrap(Class<T> iface) { return null; }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };
    }
}
