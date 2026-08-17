/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/*
 * Task 1.5 — read/write parity through the JdbcCodecs registry. A value written
 * via the codec write path (setStatementValue) must read back equal via the
 * codec read path (parseField → JdbcFieldCodec.readInto). Exercises the real
 * JDBC IO against embedded Derby, the single source of truth for both sides.
 */
package com.metaobjects.manager.db.codec;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.test.CodecSchema;
import com.metaobjects.field.TimeField;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.*;
import java.time.LocalTime;
import java.util.Collection;
import java.util.Date;
import java.util.logging.Logger;

import static org.junit.Assert.*;

public class JdbcCodecRoundTripTest {

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        loader = MetaDataLoader.fromResources("test-codec", java.util.List.of("meta.codec.json"));
        registry.registerLoader(loader);

        dbFile = "omb-codec-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return JdbcCodecRoundTripTest.getConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int s) {}
            @Override public int getLoginTimeout() { return 100; }
            @Override public Logger getParentLogger() { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };

        omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(ds);
        omdb.init();

        // Schema is external/explicit (ADR-0015): create CODEC_SAMPLE via literal DDL.
        CodecSchema.create(JdbcCodecRoundTripTest::getConnection);
    }

    private static Connection getConnection() throws SQLException {
        return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
    }

    @AfterClass
    public static void teardown() throws Exception {
        if (dbFile != null) {
            try { DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true"); }
            catch (SQLNonTransientConnectionException ignored) {}
        }
        if (loader != null) loader.destroy();
    }

    /**
     * Write a row carrying a value for each codec-handled primitive type, then
     * read it back through the codec path and assert read == written.
     */
    @Test
    public void primitivesRoundTripThroughCodecs() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("codectest::Sample");
        assertNotNull(mo);

        ObjectConnection oc = omdb.getConnection();
        try {
            ValueObject vo = (ValueObject) mo.newInstance();
            vo.setInt("count", 42);
            vo.setLong("bignum", 9_000_000_000L);   // > Integer.MAX_VALUE, proves LongCodec
            vo.setBoolean("active", true);
            vo.setDouble("ratio", 3.5d);
            vo.setFloat("rate", 2.5f);                 // FloatCodec
            vo.setObject("amount", new java.math.BigDecimal("123.45"));  // DecimalCodec
            vo.setString("label", "hello-codec");
            // field.date → a DATE column: a calendar date with no time-of-day. Author a
            // midnight-UTC instant so the value the codec writes (zone-free LocalDate) and
            // reads back is exactly this date regardless of the JVM default zone.
            Date created = Date.from(java.time.LocalDate.of(2023, 11, 14)
                .atStartOfDay(java.time.ZoneOffset.UTC).toInstant());
            vo.setDate("createdAt", created);
            vo.setObject("startTime", LocalTime.of(8, 0, 0));  // TimeCodec

            omdb.createObject(oc, vo);

            Collection<?> rows = omdb.getObjects(oc, mo,
                    new QueryOptions(new Expression("label", "hello-codec", Expression.EQUAL)));
            assertEquals("exactly one row written", 1, rows.size());

            ValueObject read = (ValueObject) rows.iterator().next();
            assertEquals("IntegerCodec round-trip", Integer.valueOf(42), read.getInt("count"));
            assertEquals("LongCodec round-trip", Long.valueOf(9_000_000_000L), read.getLong("bignum"));
            assertEquals("BooleanCodec round-trip", Boolean.TRUE, read.getBoolean("active"));
            assertEquals("DoubleCodec round-trip", Double.valueOf(3.5d), read.getDouble("ratio"));
            assertEquals("FloatCodec round-trip", Float.valueOf(2.5f), read.getFloat("rate"));
            // DecimalField is backed by DataTypes.DECIMAL (SP-D Unit 2): the field
            // surfaces an exact BigDecimal (not a lossy Double); the DecimalCodec
            // write/read goes through PreparedStatement.setBigDecimal /
            // ResultSet.getBigDecimal against a DECIMAL(18,2) column.
            assertTrue("DecimalCodec must surface a BigDecimal, not a Double",
                    read.getObject("amount") instanceof java.math.BigDecimal);
            assertEquals("DecimalCodec round-trip", 0,
                    new java.math.BigDecimal("123.45").compareTo((java.math.BigDecimal) read.getObject("amount")));
            assertEquals("StringCodec round-trip", "hello-codec", read.getString("label"));
            // DateCodec binds/reads a zone-free LocalDate against a DATE column and stores it
            // back as a midnight-UTC java.util.Date; the calendar date round-trips exactly.
            assertNotNull("DateCodec round-trip non-null", read.getDate("createdAt"));
            assertEquals("DateCodec round-trip (calendar date, midnight-UTC)",
                    created.getTime(), read.getDate("createdAt").getTime());
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    /**
     * Full OMDB end-to-end round-trip for {@code field.time} — write a {@link LocalTime}
     * through {@code omdb.createObject} and read it back through {@code omdb.getObjects}.
     *
     * <p>This exercises the complete path that was previously blocked:
     * {@code TimeCodec.readInto} → {@code MetaField.setObject} →
     * {@code DataConverter.toType(CUSTOM, localTime)}, which now passes through
     * unchanged instead of throwing {@code IllegalStateException}.
     */
    @Test
    public void timeFieldRoundTripThroughOMDB() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("codectest::Sample");
        assertNotNull(mo);

        LocalTime original = LocalTime.of(9, 30, 0);

        ObjectConnection oc = omdb.getConnection();
        try {
            ValueObject vo = (ValueObject) mo.newInstance();
            // Set all NOT-NULL columns required by the CODEC_SAMPLE schema.
            String label = "time-roundtrip-" + System.currentTimeMillis();
            vo.setString("label", label);
            vo.setInt("count", 1);
            vo.setLong("bignum", 1L);
            vo.setBoolean("active", false);
            vo.setDouble("ratio", 0d);
            vo.setFloat("rate", 0f);
            vo.setObject("amount", java.math.BigDecimal.ZERO);
            vo.setDate("createdAt", new Date(0));
            vo.setObject("startTime", original);

            omdb.createObject(oc, vo);

            Collection<?> rows = omdb.getObjects(oc, mo,
                    new QueryOptions(new Expression("label", label, Expression.EQUAL)));
            assertEquals("exactly one row written", 1, rows.size());

            ValueObject read = (ValueObject) rows.iterator().next();
            assertEquals("TimeField LocalTime must survive full OMDB write+read round-trip",
                    original, read.getObject("startTime"));
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    /**
     * SP-H Unit 5 — full OMDB round-trip for the codecs that previously had NO dedicated
     * codec and rode the generic {@code ObjectCodec} fallback: {@code field.timestamp}
     * (the highest-risk write hazard — {@code setObject(java.util.Date)} is rejected by
     * pgjdbc), {@code field.currency} (BIGINT minor units), and {@code field.enum} (text).
     * Exercises write codec → read codec on embedded Derby.
     *
     * <p>{@code field.uuid} is NOT exercised here: OMDB binds a native uuid column via
     * {@code setObject(.., Types.OTHER)} (see {@link UuidCodec} /
     * {@code GenericSQLDriver.isUuidColumn}), which Derby rejects ("data type 'OTHER' is
     * not supported"). The native-uuid AND timestamptz WRITE paths are gated against real
     * Postgres by the persistence-conformance {@code op: roundtrip} scenario; the UuidCodec
     * read-back-lowercase contract is covered at the raw-JDBC boundary by
     * {@link #uuidCodecReadsBackLowercaseCanonical()}.</p>
     */
    @Test
    public void timestampCurrencyEnumRoundTripThroughOMDB() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("codectest::Sample");
        assertNotNull(mo);

        // 14:30:00.123 UTC on 2026-06-03, expressed as epoch millis so the assertion is
        // zone-independent (the value written is the value read back).
        Date ts = new Date(java.time.Instant.parse("2026-06-03T14:30:00.123Z").toEpochMilli());

        ObjectConnection oc = omdb.getConnection();
        try {
            ValueObject vo = (ValueObject) mo.newInstance();
            String label = "tcu-roundtrip-" + System.currentTimeMillis();
            // NOT-NULL columns from CodecSchema.
            vo.setString("label", label);
            vo.setInt("count", 1);
            vo.setLong("bignum", 1L);
            vo.setBoolean("active", false);
            vo.setDouble("ratio", 0d);
            vo.setFloat("rate", 0f);
            vo.setObject("amount", java.math.BigDecimal.ZERO);
            vo.setDate("createdAt", new Date(0));
            vo.setObject("startTime", LocalTime.of(0, 0, 0));
            // The SP-H subtypes under test.
            vo.setDate("tsVal", ts);                  // TimestampCodec
            vo.setLong("moneyVal", 199900L);          // CurrencyCodec (integer minor units)
            vo.setString("status", "MEDIUM");         // EnumCodec (string-backed)
            vo.setString("priority", "PUBLISHED");    // EnumCodec (int-backed, @intValueMap)

            omdb.createObject(oc, vo);

            Collection<?> rows = omdb.getObjects(oc, mo,
                    new QueryOptions(new Expression("label", label, Expression.EQUAL)));
            assertEquals("exactly one row written", 1, rows.size());
            ValueObject read = (ValueObject) rows.iterator().next();

            // Plain TIMESTAMP reads back zone-free: the codec reads via getTimestamp(UTC), so the
            // Timestamp's INSTANT anchors the stored wall clock at UTC. Recover the wall clock as
            // instant @ UTC (the wire normalizer does the same) — independent of the JVM zone.
            Object tsRead = read.getDate("tsVal");
            assertNotNull("TimestampCodec round-trip non-null", tsRead);
            assertTrue("TimestampCodec must surface a java.sql.Timestamp for a plain TIMESTAMP",
                    tsRead instanceof Timestamp);
            assertEquals("TimestampCodec must round-trip the UTC wall clock exactly",
                    java.time.LocalDateTime.ofInstant(
                            java.time.Instant.ofEpochMilli(ts.getTime()), java.time.ZoneOffset.UTC),
                    ((Timestamp) tsRead).toInstant().atZone(java.time.ZoneOffset.UTC).toLocalDateTime());
            assertEquals("CurrencyCodec must round-trip integer minor units",
                    Long.valueOf(199900L), read.getLong("moneyVal"));
            assertEquals("EnumCodec must round-trip the member symbol",
                    "MEDIUM", read.getString("status"));

            // int-backed enum (@intValueMap): the caller's contract is the SYMBOL in
            // both directions — int-backing is invisible above the codec.
            assertEquals("EnumCodec must round-trip an int-backed member as its symbol",
                    "PUBLISHED", read.getString("priority"));

            // ...and ask the DATABASE what it actually stored. A round-trip alone
            // cannot tell a working int codec from one that wrote the symbol both
            // ways, because a symmetric bug is self-consistent. PUBLISHED is declared
            // as 5, and the column is INTEGER.
            try (Connection c = getConnection();
                 PreparedStatement ps = c.prepareStatement(
                         "SELECT priority FROM CODEC_SAMPLE WHERE label = ?")) {
                ps.setString(1, label);
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue("row present for raw column read", rs.next());
                    assertEquals("the column must hold the declared int, not the symbol",
                            5, rs.getInt(1));
                }
            }
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    /**
     * An int-backed {@code field.enum} column holding an integer that maps to NO member is
     * data the model says is impossible. The codec must THROW rather than surface the raw
     * int as a pseudo-symbol: the sibling ports type this property as a CLOSED enum, so a
     * value like {@code "7"} is not representable there, and returning null would hide the
     * corruption behind a nullable column.
     *
     * <p>Written through OMDB with a legal member, then corrupted with raw SQL — the same
     * shape as the drift this guards against (a hand-written INSERT, or a member removed
     * without a migration).</p>
     */
    @Test
    public void intBackedEnumThrowsOnAnUnmappedStoredValue() throws Exception {
        MetaObject mo = registry.findMetaObjectByName("codectest::Sample");
        assertNotNull(mo);

        ObjectConnection oc = omdb.getConnection();
        try {
            ValueObject vo = (ValueObject) mo.newInstance();
            String label = "unmapped-int-enum-" + System.currentTimeMillis();
            vo.setString("label", label);
            vo.setInt("count", 1);
            vo.setLong("bignum", 1L);
            vo.setBoolean("active", false);
            vo.setDouble("ratio", 0d);
            vo.setFloat("rate", 0f);
            vo.setObject("amount", java.math.BigDecimal.ZERO);
            vo.setDate("createdAt", new Date(0));
            vo.setObject("startTime", LocalTime.of(0, 0, 0));
            vo.setString("priority", "PUBLISHED");
            omdb.createObject(oc, vo);

            // 7 is in no member's @intValueMap (DRAFT=0, PUBLISHED=5, ARCHIVED=9).
            try (Connection c = getConnection();
                 PreparedStatement ps = c.prepareStatement(
                         "UPDATE CODEC_SAMPLE SET priority = 7 WHERE label = ?")) {
                ps.setString(1, label);
                assertEquals("exactly one row corrupted", 1, ps.executeUpdate());
            }

            try {
                omdb.getObjects(oc, mo,
                        new QueryOptions(new Expression("label", label, Expression.EQUAL)));
                fail("reading an unmapped int-backed enum value must throw, not surface it");
            } catch (Exception e) {
                assertTrue("the failure must name the unmapped value: " + messageChain(e),
                        messageChain(e).contains("7"));
                assertTrue("the failure must name the attribute: " + messageChain(e),
                        messageChain(e).contains("intValueMap"));
            }
        } finally {
            omdb.releaseConnection(oc);
        }
    }

    /** Every message in a throwable's cause chain, joined — OMDB wraps driver exceptions. */
    private static String messageChain(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = t; c != null; c = c.getCause()) {
            sb.append(c.getMessage()).append(" | ");
            if (c.getCause() == c) break;
        }
        return sb.toString();
    }

    /**
     * {@link UuidCodec} read-back-lowercase contract at the raw codec/JDBC boundary. The
     * native-uuid WRITE bind ({@code setObject(.., Types.OTHER)}) is Postgres-only (Derby
     * rejects {@code OTHER}), so seed a CHAR column with a verbatim (upper-case) UUID string
     * via raw SQL and assert {@code readInto} lowercases it to the cross-port canonical form.
     */
    @Test
    public void uuidCodecReadsBackLowercaseCanonical() throws Exception {
        final java.util.Map<String, Object> store = new java.util.HashMap<>();
        com.metaobjects.field.UuidField uuidField = new com.metaobjects.field.UuidField("uuidVal") {
            @Override public void setString(Object obj, String value) { store.put("v", value); }
        };
        JdbcCodecs.UuidCodec codec = new JdbcCodecs.UuidCodec();

        try (Connection conn = getConnection()) {
            try (Statement st = conn.createStatement()) {
                st.execute("CREATE TABLE codec_uuid_probe (u VARCHAR(36))");
                st.execute("INSERT INTO codec_uuid_probe (u) VALUES "
                        + "('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')");
            }
            try (Statement st = conn.createStatement();
                 ResultSet rs = st.executeQuery("SELECT u FROM codec_uuid_probe")) {
                assertTrue("one row seeded", rs.next());
                codec.readInto(new Object(), uuidField, rs, 1);
            }
            assertEquals("UuidCodec must read back lowercase-canonical",
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", store.get("v"));
            try (Statement st = conn.createStatement()) {
                st.execute("DROP TABLE codec_uuid_probe");
            }
        }
    }

    /**
     * W2b zone-codec fix — {@code TimestampCodec} (plain TIMESTAMP) is zone-INDEPENDENT.
     *
     * <p>Drives the codec's {@code write → read} against a real TIMESTAMP column while the JVM
     * default zone is pinned to a NON-UTC zone (America/Los_Angeles). Before the fix the codec
     * bound/read via {@code setTimestamp}/{@code getTimestamp}, which convert through the default
     * zone — so the UTC wall clock written did NOT come back as the same wall clock under a
     * non-UTC zone (it shifted by the zone offset). The zone-free {@code setObject(LocalDateTime)}
     * / {@code getObject(LocalDateTime.class)} stores and reads the exact wall clock regardless of
     * the default zone. This is the regression guard the symmetric UTC-pinned round-trip masked.</p>
     */
    @Test
    public void timestampCodecIsZoneIndependentAtTheJdbcBoundary() throws Exception {
        final java.util.Map<String, Object> store = new java.util.HashMap<>();
        com.metaobjects.field.TimestampField tsField = new com.metaobjects.field.TimestampField("tsVal") {
            @Override public void setDate(Object obj, Date value) { store.put("v", value); }
        };
        // @localTime:true selects the naive ("timestamp WITHOUT time zone") codec path — the only
        // one Derby's plain TIMESTAMP column supports. The instant/tz default (no @localTime) binds
        // via setObject(TIMESTAMP_WITH_TIMEZONE), gated against real Postgres in persistence-conformance.
        tsField.addMetaAttr(com.metaobjects.attr.BooleanAttribute.create(
                com.metaobjects.database.CoreDBMetaDataProvider.LOCAL_TIME, true));
        JdbcCodecs.TimestampCodec codec = new JdbcCodecs.TimestampCodec();

        // The UTC wall clock the corpus asserts (no zone).
        java.time.LocalDateTime utcWallClock = java.time.LocalDateTime.of(2026, 6, 3, 14, 30, 0, 123_000_000);
        Date written = Date.from(utcWallClock.toInstant(java.time.ZoneOffset.UTC));

        java.util.TimeZone savedZone = java.util.TimeZone.getDefault();
        try {
            // Pin a non-UTC default zone for the duration of the JDBC IO.
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/Los_Angeles"));
            try (Connection conn = getConnection()) {
                try (Statement st = conn.createStatement()) {
                    st.execute("CREATE TABLE codec_ts_probe (t TIMESTAMP)");
                }
                try (PreparedStatement ps = conn.prepareStatement("INSERT INTO codec_ts_probe (t) VALUES (?)")) {
                    codec.write(ps, tsField, 1, written);
                    ps.executeUpdate();
                }
                try (Statement st = conn.createStatement();
                     ResultSet rs = st.executeQuery("SELECT t FROM codec_ts_probe")) {
                    assertTrue("one row written", rs.next());
                    codec.readInto(new Object(), tsField, rs, 1);
                }
                try (Statement st = conn.createStatement()) {
                    st.execute("DROP TABLE codec_ts_probe");
                }
            }
        } finally {
            java.util.TimeZone.setDefault(savedZone);
        }

        Date readBack = (Date) store.get("v");
        assertNotNull("TimestampCodec round-trip non-null", readBack);
        assertTrue("TimestampCodec must surface a java.sql.Timestamp", readBack instanceof Timestamp);
        // Recover the wall clock zone-free (instant @ UTC), exactly as the wire normalizer does.
        assertEquals("TimestampCodec must round-trip the UTC wall clock under a NON-UTC default zone",
                utcWallClock, ((Timestamp) readBack).toInstant().atZone(java.time.ZoneOffset.UTC).toLocalDateTime());
    }

    /**
     * W2b zone-codec fix — {@code DateCodec} (DATE column) is zone-INDEPENDENT.
     *
     * <p>Same hazard as the timestamp case, narrowed to a calendar date: under a non-UTC default
     * zone the old {@code setTimestamp}/{@code getTimestamp} path could roll a midnight-UTC date to
     * the adjacent day. The zone-free {@code setObject(LocalDate)} / {@code getObject(LocalDate.class)}
     * preserves the calendar date exactly.</p>
     */
    @Test
    public void dateCodecIsZoneIndependentAtTheJdbcBoundary() throws Exception {
        final java.util.Map<String, Object> store = new java.util.HashMap<>();
        com.metaobjects.field.DateField dateField = new com.metaobjects.field.DateField("d") {
            @Override public void setDate(Object obj, Date value) { store.put("v", value); }
        };
        JdbcCodecs.DateCodec codec = new JdbcCodecs.DateCodec();

        java.time.LocalDate expectedDate = java.time.LocalDate.of(2026, 6, 3);
        Date written = Date.from(expectedDate.atStartOfDay(java.time.ZoneOffset.UTC).toInstant());

        java.util.TimeZone savedZone = java.util.TimeZone.getDefault();
        try {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/Los_Angeles"));
            try (Connection conn = getConnection()) {
                try (Statement st = conn.createStatement()) {
                    st.execute("CREATE TABLE codec_date_probe (d DATE)");
                }
                try (PreparedStatement ps = conn.prepareStatement("INSERT INTO codec_date_probe (d) VALUES (?)")) {
                    codec.write(ps, dateField, 1, written);
                    ps.executeUpdate();
                }
                try (Statement st = conn.createStatement();
                     ResultSet rs = st.executeQuery("SELECT d FROM codec_date_probe")) {
                    assertTrue("one row written", rs.next());
                    codec.readInto(new Object(), dateField, rs, 1);
                }
                try (Statement st = conn.createStatement()) {
                    st.execute("DROP TABLE codec_date_probe");
                }
            }
        } finally {
            java.util.TimeZone.setDefault(savedZone);
        }

        Date readBack = (Date) store.get("v");
        assertNotNull("DateCodec round-trip non-null", readBack);
        java.time.LocalDate actualDate = readBack.toInstant().atZone(java.time.ZoneOffset.UTC).toLocalDate();
        assertEquals("DateCodec must round-trip the calendar date under a NON-UTC default zone",
                expectedDate, actualDate);
    }

    /**
     * TimeCodec symmetry at the raw codec/JDBC boundary (codec unit test, not OMDB
     * end-to-end). Uses a verbatim-storing TimeField subclass to isolate ONLY the
     * codec's {@code LocalTime → java.sql.Time → LocalTime} JDBC conversion.
     */
    @Test
    public void timeCodecIsSymmetricAtTheJdbcBoundary() throws Exception {
        // Verbatim-storing TimeField: bypasses DataConverter's CUSTOM-type hop so we
        // exercise ONLY the codec's JDBC conversion, not the documented MetaField gap.
        final java.util.Map<String, Object> store = new java.util.HashMap<>();
        TimeField timeField = new TimeField("startTime") {
            @Override public void setObject(Object obj, Object value) { store.put("v", value); }
            @Override public Object getObject(Object obj) { return store.get("v"); }
        };

        JdbcCodecs.TimeCodec codec = new JdbcCodecs.TimeCodec();
        LocalTime original = LocalTime.of(13, 45, 30);

        try (Connection conn = getConnection()) {
            try (Statement st = conn.createStatement()) {
                st.execute("CREATE TABLE codec_time_probe (t TIME)");
            }

            // WRITE side: bind the LocalTime through TimeCodec.write.
            try (PreparedStatement ps = conn.prepareStatement("INSERT INTO codec_time_probe (t) VALUES (?)")) {
                codec.write(ps, timeField, 1, original);
                ps.executeUpdate();
            }

            // READ side: pull it back through TimeCodec.readInto.
            try (Statement st = conn.createStatement();
                 ResultSet rs = st.executeQuery("SELECT t FROM codec_time_probe")) {
                assertTrue("one row written", rs.next());
                Object target = new Object();
                codec.readInto(target, timeField, rs, 1);
            }

            assertEquals("TimeCodec must round-trip a LocalTime symmetrically through JDBC",
                    original, store.get("v"));

            try (Statement st = conn.createStatement()) {
                st.execute("DROP TABLE codec_time_probe");
            }
        }
    }
}
