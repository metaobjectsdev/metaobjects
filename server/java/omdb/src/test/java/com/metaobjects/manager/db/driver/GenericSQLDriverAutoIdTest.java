package com.metaobjects.manager.db.driver;

import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.NameDef;
import com.metaobjects.manager.db.defs.TableDef;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.Statement;
import java.sql.Types;

import static org.junit.Assert.assertEquals;

/**
 * Regression test for {@link GenericSQLDriver#getNextAutoId} which previously parsed the
 * {@code MAX(col)} result with {@link Integer#parseInt}, overflowing BIGINT / LongField ids
 * above {@link Integer#MAX_VALUE}. The fallback now parses as {@code long}.
 *
 * <p>Uses embedded in-memory Derby (no Testcontainers required), so it runs in the
 * standard {@code omdb} unit suite.</p>
 */
public class GenericSQLDriverAutoIdTest {

    private static String dbFile;

    /** Exposes the protected fallback for direct testing. */
    private static final class TestDriver extends GenericSQLDriver {
        String nextAutoId(Connection c, ColumnDef col) throws SQLException {
            return getNextAutoId(c, col);
        }
    }

    @BeforeClass
    public static void setUp() throws Exception {
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        dbFile = "autoid-testing-" + System.currentTimeMillis();
        try (Connection c = getConnection(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE BIG_SEQ ( ID BIGINT )");
            // A value well above Integer.MAX_VALUE (2147483647).
            s.execute("INSERT INTO BIG_SEQ ( ID ) VALUES ( 5000000000 )");
        }
    }

    @AfterClass
    public static void tearDown() {
        try {
            DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true");
        } catch (SQLNonTransientConnectionException ignored) {
        } catch (SQLException ignored) {
        }
    }

    private static Connection getConnection() throws SQLException {
        return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
    }

    @Test
    public void nextAutoIdDoesNotOverflowAboveIntMax() throws Exception {
        ColumnDef col = new ColumnDef("ID", Types.BIGINT);
        TableDef table = new TableDef(new NameDef(null, "BIG_SEQ"));
        col.setBaseTable(table);

        TestDriver driver = new TestDriver();
        try (Connection c = getConnection()) {
            String next = driver.nextAutoId(c, col);
            // 5,000,000,000 + 1 — would have thrown NumberFormatException / truncated under int parsing.
            assertEquals("5000000001", next);
        }
    }
}
