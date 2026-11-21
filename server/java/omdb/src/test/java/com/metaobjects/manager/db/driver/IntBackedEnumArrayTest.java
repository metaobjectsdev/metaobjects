package com.metaobjects.manager.db.driver;

import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.object.MetaObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * An int-backed {@code field.enum} ARRAY ({@code @intValueMap} + {@code isArray}, here inherited
 * from a shared abstract enum) stores each member as its declared integer and reads each integer
 * back as its member: a native {@code integer[]} on Postgres, a JSON array of numbers
 * ({@code [5,0]}) in a text column everywhere else. A member symbol is never stored and a member
 * nobody declared is never invented, on either side. A real in-memory SQLite proves the JSON-text
 * form, since it is the engine that accepted the symbols silently before the array was supported.
 */
public class IntBackedEnumArrayTest {
    private static final String META = "{ \"metadata.root\": { \"package\": \"ivm\", \"children\": ["
        + "  { \"field.enum\": { \"name\": \"Stage\", \"abstract\": true,"
        + "      \"@values\": [\"DRAFT\", \"PUBLISHED\", \"ARCHIVED\"],"
        + "      \"@intValueMap\": { \"DRAFT\": 0, \"PUBLISHED\": 5, \"ARCHIVED\": 9 } } },"
        + "  { \"object.entity\": { \"name\": \"Doc\", \"children\": ["
        + "    { \"source.rdb\": { \"@table\": \"doc\" } },"
        + "    { \"field.long\": { \"name\": \"id\" } },"
        + "    { \"field.enum\": { \"name\": \"stage\", \"extends\": \"ivm::Stage\" } },"
        + "    { \"field.enum\": { \"name\": \"history\", \"extends\": \"ivm::Stage\", \"isArray\": true } },"
        + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } }"
        + "  ] } }"
        + "] } }";

    /** Exposes the protected bind and read hooks. */
    private static final class TestDriver extends SQLiteDriver {
        void bind(PreparedStatement s, MetaField<?> f, int i, Object v) throws SQLException {
            setStatementValue(s, f, i, v);
        }
        void read(Object o, MetaField<?> f, ResultSet rs, int j) throws SQLException {
            parseField(o, f, rs, j);
        }
    }

    private static MetaField<?> history;
    private static MetaField<?> stage;
    private final TestDriver driver = new TestDriver();

    @BeforeClass
    public static void load() {
        MetaDataLoader loader = MetaDataLoader.fromString(
            "ivm-array-" + UUID.randomUUID().toString().substring(0, 8), META, MetaDataSource.MetaDataFormat.JSON);
        MetaObject doc = loader.getMetaObjectByName("ivm::Doc");
        history = doc.getMetaField("history");
        stage = doc.getMetaField("stage");
    }

    private static String stored(Connection c, int id) throws SQLException {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("SELECT history FROM doc WHERE id = " + id)) {
            assertTrue(rs.next());
            return rs.getString(1);
        }
    }

    private void insert(Connection c, int id, Object value) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("INSERT INTO doc (id, history) VALUES (" + id + ", ?)")) {
            driver.bind(ps, history, 1, value);
            ps.executeUpdate();
        }
    }

    @SuppressWarnings("unchecked")
    private Object read(Connection c, int id) throws SQLException {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("SELECT history FROM doc WHERE id = " + id)) {
            assertTrue(rs.next());
            HashMap<String, Object> row = new HashMap<>();
            driver.read(row, history, rs, 1);
            return history.getObjectArray(row);
        }
    }

    @Test
    public void anArrayStoresEachMembersDeclaredIntegerNotTheSymbols() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE doc (id INTEGER, history TEXT)");
            insert(c, 1, List.of("PUBLISHED", "DRAFT"));
            insert(c, 2, List.of());
            insert(c, 3, null);
            assertEquals("[5,0]", stored(c, 1));
            assertEquals("[]", stored(c, 2));
            assertEquals(null, stored(c, 3));
        }
    }

    @Test
    public void storedIntegersReadBackAsMembersInOrderAndNullStaysNull() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE doc (id INTEGER, history TEXT)");
            st.execute("INSERT INTO doc VALUES (1, '[5,0]'), (2, '[]'), (3, NULL), (4, '[9]')");
            assertEquals(List.of("PUBLISHED", "DRAFT"), read(c, 1));
            assertEquals(List.of(), read(c, 2));
            assertEquals(null, read(c, 3));
            assertEquals(List.of("ARCHIVED"), read(c, 4));
        }
    }

    @Test
    public void aStoredIntegerWithNoMemberFailsTheRead() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE doc (id INTEGER, history TEXT)");
            st.execute("INSERT INTO doc VALUES (1, '[5,42]')");
            try {
                read(c, 1);
                fail("an unmapped stored element must throw, as an unmapped scalar does");
            } catch (SQLException expected) {
                assertTrue(expected.getMessage(), expected.getMessage().contains("history"));
                assertTrue(expected.getMessage(), expected.getMessage().contains("42"));
            }
        }
    }

    @Test
    public void storedTextThatIsNotAnArrayOfNumbersFailsTheRead() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE doc (id INTEGER, history TEXT)");
            st.execute("INSERT INTO doc VALUES (1, 'PUBLISHED')");
            try {
                read(c, 1);
                fail("text that is not a JSON array of numbers must throw");
            } catch (SQLException expected) {
                assertTrue(expected.getMessage(), expected.getMessage().contains("history"));
            }
        }
    }

    @Test
    public void aMemberWithNoDeclaredIntegerIsRefusedAndNothingIsStored() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE doc (id INTEGER, history TEXT)");
            try {
                insert(c, 1, List.of("PUBLISHED", "NOT_A_MEMBER"));
                fail("an unmapped member must not be bound");
            } catch (SQLException expected) {
                assertTrue(expected.getMessage(), expected.getMessage().contains("NOT_A_MEMBER"));
            }
            try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM doc")) {
                assertTrue(rs.next());
                assertEquals("no row may be written", 0, rs.getInt(1));
            }
        }
    }

    /** Exposes the protected element-type hook of the Postgres driver. */
    private static final class PgDriver extends PostgresDriver {
        String elementType(MetaField<?> f) {
            return nativeArrayElementType(f);
        }
    }

    @Test
    public void postgresMapsTheArrayToANativeIntegerArrayAndTheScalarToNone() {
        PgDriver pg = new PgDriver();
        assertEquals("integer", pg.elementType(history));
        assertEquals(null, pg.elementType(stage));
    }

    @Test
    public void theScalarSiblingSharingTheMapStillStoresItsInt() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE doc (id INTEGER, stage INTEGER)");
            try (PreparedStatement ps = c.prepareStatement("INSERT INTO doc (id, stage) VALUES (1, ?)")) {
                driver.bind(ps, stage, 1, "PUBLISHED");
                ps.executeUpdate();
            }
            try (ResultSet rs = st.executeQuery("SELECT stage FROM doc")) {
                assertTrue(rs.next());
                assertEquals(5, rs.getInt(1));
            }
        }
    }
}
