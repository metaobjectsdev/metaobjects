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
 * from a shared abstract enum) loads, but OMDB persists no enum array of either kind: no driver
 * maps an enum to a native array column ({@link PostgresDriver#nativeArrayElementType} answers
 * only {@code text} / {@code uuid} / {@code numeric}), so the value reaches the SCALAR enum codec.
 *
 * <p>That codec must refuse rather than guess. Before the refusal it bound the list's
 * {@code toString()} — the member SYMBOLS, {@code "[PUBLISHED, DRAFT]"} — into the column, which a
 * text-affinity SQLite column accepted silently; and it read a stored {@code "[5,0]"} through
 * {@code getInt}, which SQLite answers with {@code 0}: a member nobody stored. Both are the failure
 * an int-backed array must never have. A real in-memory SQLite proves it, since it is the engine
 * that accepts both silently.</p>
 */
public class IntBackedEnumArrayRefusalTest {

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

    @Test
    public void writingAnArrayRefusesInsteadOfStoringTheSymbols() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE doc (id INTEGER, history TEXT)");
            try (PreparedStatement ps = c.prepareStatement("INSERT INTO doc (id, history) VALUES (1, ?)")) {
                try {
                    driver.bind(ps, history, 1, List.of("PUBLISHED", "DRAFT"));
                    ps.executeUpdate();
                } catch (SQLException expected) {
                    assertTrue(expected.getMessage(), expected.getMessage().contains("history"));
                }
            }
            try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM doc")) {
                assertTrue(rs.next());
                assertEquals("no row may hold the member symbols", 0, rs.getInt(1));
            }
        }
    }

    @Test
    public void readingAnArrayRefusesInsteadOfInventingAMember() throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:"); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE doc (id INTEGER, history TEXT)");
            st.execute("INSERT INTO doc VALUES (1, '[5,0]')");
            try (ResultSet rs = st.executeQuery("SELECT history FROM doc")) {
                assertTrue(rs.next());
                HashMap<String, Object> row = new HashMap<>();
                driver.read(row, history, rs, 1);
                fail("reading an int-backed enum array through the scalar codec must throw; read " + row);
            } catch (SQLException expected) {
                assertTrue(expected.getMessage(), expected.getMessage().contains("history"));
            }
        }
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
