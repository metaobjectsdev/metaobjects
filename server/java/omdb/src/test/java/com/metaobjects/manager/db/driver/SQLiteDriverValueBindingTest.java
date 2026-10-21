package com.metaobjects.manager.db.driver;

import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.TimestampField;
import org.junit.Test;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Date;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * How SQLiteDriver binds values against a real SQLite. SQLite orders every number before any
 * text, so a decimal operand bound as text would make {@code realColumn > '0'} false for every
 * row; these pin the bind to a number, and dates and timestamps to the ISO text the schema holds.
 */
public class SQLiteDriverValueBindingTest {

    /** Exposes the protected bind hook. */
    private static final class TestDriver extends SQLiteDriver {
        void bind(PreparedStatement s, MetaField<?> f, int i, Object v) throws SQLException {
            setStatementValue(s, f, i, v);
        }
    }

    private final TestDriver driver = new TestDriver();

    @Test
    public void aDecimalOperandComparesAsANumberAgainstARealColumn() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE t (x REAL)");
            st.execute("INSERT INTO t VALUES (0.4)");
            for (String[] probe : new String[][] {{"0", "1"}, {"0.5", "0"}, {"0.4", "1"}, {"0.40", "1"}}) {
                try (PreparedStatement ps = c.prepareStatement("SELECT COUNT(*) FROM (SELECT x * 1 AS y FROM t) WHERE y >= ?")) {
                    driver.bind(ps, new DecimalField("d"), 1, new BigDecimal(probe[0]));
                    try (ResultSet rs = ps.executeQuery()) {
                        assertTrue(rs.next());
                        assertEquals("operand " + probe[0], Integer.parseInt(probe[1]), rs.getInt(1));
                    }
                }
            }
        }
    }

    @Test
    public void aDateAndATimestampAreBoundAsIsoText() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:")) {
            Date instant = Date.from(java.time.Instant.parse("2026-03-04T05:06:07.250Z"));
            try (PreparedStatement ps = c.prepareStatement("SELECT ?, ?")) {
                driver.bind(ps, new TimestampField("ts"), 1, instant);
                driver.bind(ps, new DateField("d"), 2, java.time.LocalDate.parse("2026-03-04"));
                try (ResultSet rs = ps.executeQuery()) {
                    assertTrue(rs.next());
                    assertEquals("2026-03-04T05:06:07.250Z", rs.getString(1));
                    assertEquals("2026-03-04", rs.getString(2));
                }
            }
        }
    }
}
