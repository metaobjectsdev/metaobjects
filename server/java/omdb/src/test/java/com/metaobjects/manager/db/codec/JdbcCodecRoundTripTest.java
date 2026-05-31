/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
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
            Date created = new Date(1_700_000_000_000L);
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
            // DateCodec stores as a timestamp; compare epoch millis.
            assertNotNull("DateCodec round-trip non-null", read.getDate("createdAt"));
            assertEquals("DateCodec round-trip", created.getTime(), read.getDate("createdAt").getTime());
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
