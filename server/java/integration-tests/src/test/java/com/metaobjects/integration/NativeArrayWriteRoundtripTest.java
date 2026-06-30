package com.metaobjects.integration;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
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
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * dbColumnType slim-and-derive (Phase 1) — the OMDB runtime WRITE+READ gate for
 * <em>native array columns</em> ({@code field.string isArray} → {@code text[]},
 * {@code field.uuid isArray} → {@code uuid[]}).
 *
 * <p><b>Why this test exists.</b> The array-ness of a column is now <em>derived</em>
 * from the field subtype + {@code isArray:true} (ADR-0023; the {@code @dbColumnType:
 * text_array}/{@code uuid_array} declared values were removed). Before this change OMDB
 * had no native-array JDBC binding at all — a `text[]`/`uuid[]` column would draw a
 * varchar↔array mismatch on INSERT. This test INSERTs through {@link ObjectManagerDB#createObject}
 * (NOT raw SQL) and reads the row back, asserting the List values survive
 * {@code Connection.createArrayOf} (write) and {@code ResultSet.getArray} (read).</p>
 *
 * <p>Postgres-only (the {@code docker} CLI container helper). Not part of the default
 * Maven reactor — run via {@code mvn -f server/java/integration-tests/pom.xml test}.</p>
 */
final class NativeArrayWriteRoundtripTest {

    /** Inline canonical metadata: an entity with a text[] and a uuid[] array field. */
    private static final String META = "{ \"metadata.root\": { \"package\": \"arr\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Bag\", \"children\": ["
        + "    { \"source.rdb\": { \"@table\": \"bag\" } },"
        + "    { \"field.uuid\": { \"name\": \"id\" } },"
        + "    { \"field.string\": { \"name\": \"tags\", \"isArray\": true } },"
        + "    { \"field.uuid\": { \"name\": \"refs\", \"isArray\": true } },"
        + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\", \"@generation\": \"uuid\" } }"
        + "  ] } }"
        + "] } }";

    /** Matching DDL — native text[] / uuid[] columns (what the canonical TS schema would emit). */
    private static final String DDL =
        "CREATE TABLE bag ("
        + "  id uuid PRIMARY KEY,"
        + "  tags text[],"
        + "  refs uuid[]"
        + ")";

    @BeforeAll
    static void bindEntity() {
        if (ObjectClassRegistry.global().resolve("arr::Bag") != null) return;
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> Map.of("arr::Bag", ValueObject.class));
        ObjectClassRegistry.setGlobal(reg);
    }

    @Test
    void textAndUuidArraysRoundTripThroughOmdbWrite() throws Exception {
        try (PostgresContainer pg = new PostgresContainer()) {
            MetaDataLoader loader = MetaDataLoader.fromString(
                "native-array-" + UUID.randomUUID().toString().substring(0, 8),
                META, MetaDataSource.MetaDataFormat.JSON);
            ObjectManagerDB omdb = newOmdb(pg);
            provisionSchema(pg);

            MetaObject bag = findByShortName(loader, "Bag");
            assertNotNull(bag, "loader must contain Bag");

            List<String> tags = List.of("alpha", "beta", "gamma");
            // Mixed case on input to prove the uuid[] read normalises lowercase-canonical.
            List<String> refsIn = List.of(
                "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
                "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB");
            List<String> refsExpected = List.of(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

            ValueObject vo = (ValueObject) bag.newInstance();
            vo.setObjectArray("tags", tags);
            vo.setObjectArray("refs", refsIn);

            ObjectConnection oc = omdb.getConnection();
            try {
                omdb.createObject(oc, vo); // INSERT via the OMDB runtime write path
                Object id = vo.get("id");
                assertNotNull(id, "OMDB should mint the uuid PK on insert");

                Collection<?> rows = omdb.getObjects(oc, bag,
                    new QueryOptions(new Expression("id", id, Expression.EQUAL)));
                assertEquals(1, rows.size(), "inserted row must read back");
                ValueObject readBack = (ValueObject) rows.iterator().next();

                assertEquals(tags, readBack.getStringArray("tags"),
                    "text[] must round-trip through OMDB write+read");
                assertEquals(refsExpected, readBack.getStringArray("refs"),
                    "uuid[] must round-trip lowercase-canonical through OMDB write+read");
            } finally {
                omdb.releaseConnection(oc);
            }
        }
    }

    // -----------------------------------------------------------------------
    // OMDB + Postgres plumbing (mirrors OpenJsonbWriteRoundtripTest)
    // -----------------------------------------------------------------------

    private static ObjectManagerDB newOmdb(PostgresContainer pg) throws Exception {
        ObjectManagerDB omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new PostgresDriver());
        omdb.setDataSource(dataSource(pg));
        omdb.init();
        return omdb;
    }

    private static void provisionSchema(PostgresContainer pg) throws Exception {
        try (Connection c = openConnection(pg); Statement s = c.createStatement()) {
            s.execute(DDL);
        }
    }

    private static MetaObject findByShortName(MetaDataLoader loader, String shortName) {
        for (MetaObject mc : loader.getMetaObjects()) {
            if (mc.getShortName().equals(shortName)) return mc;
        }
        return null;
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
            @Override public Logger getParentLogger() { return Logger.getLogger("native-array-test"); }
            @Override public <T> T unwrap(Class<T> iface) { return null; }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };
    }
}
