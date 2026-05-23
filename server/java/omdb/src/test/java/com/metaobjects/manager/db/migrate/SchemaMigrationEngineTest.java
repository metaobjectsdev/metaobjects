package com.metaobjects.manager.db.migrate;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.file.FileLoaderOptions;
import com.metaobjects.loader.file.FileMetaDataLoader;
import com.metaobjects.loader.file.LocalFileMetaDataSources;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;

import org.junit.AfterClass;
import org.junit.Before;
import org.junit.After;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.*;
import java.util.logging.Logger;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

/**
 * End-to-end test for SchemaMigrationEngine: verifies diff/verify/emit/apply
 * round-trip on a fresh Derby in-memory DB using the meta.expected.json fixture
 * (Program entity -> table "program" with id + title).
 *
 * Each test method gets its own fresh in-memory Derby DB (per-method unique name)
 * for clean isolation. No MetaClassDBValidatorService is used — the engine is
 * the schema authority in this test, not the validator.
 */
public class SchemaMigrationEngineTest {

    // ---------------------------------------------------------------------------
    // Static infrastructure (shared loader + registry; DB is per-test)
    // ---------------------------------------------------------------------------

    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;
    private static ObjectManagerDB omdb;

    private static final AtomicInteger dbSeq = new AtomicInteger();

    /** Per-test in-memory DB name; set in @Before */
    private String dbName;
    private Connection testConn;

    @BeforeClass
    public static void setupShared() throws Exception {
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");

        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());

        FileMetaDataLoader xl = new FileMetaDataLoader(
            new FileLoaderOptions()
                .setShouldRegister(false)
                .setAllowAutoAttrs(true)
                .setStrict(false)
                .setVerbose(false),
            "test-engine-db");

        xl.init(new LocalFileMetaDataSources("meta.expected.json"));
        xl.register();
        registry.registerLoader(xl);
        loader = xl;

        // omdb uses a DataSource that delegates to the per-test dbName.
        // We create omdb once and point it at a DataSource whose connection
        // resolution is delegated to #testConn (set per-test).
        omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(buildDelegatingDataSource());
        omdb.init();
    }

    /**
     * Builds a DataSource that delegates getConnection() to the per-test in-memory
     * Derby DB identified by dbName. The DataSource itself is stateless; each call
     * opens a new connection to the current dbName.
     */
    private static DataSource buildDelegatingDataSource() {
        return new DataSource() {
            @Override public Connection getConnection() throws SQLException {
                // dbName is set per-test in @Before; return a fresh connection each time.
                return DriverManager.getConnection(
                    "jdbc:derby:memory:" + currentDbName() + ";create=true");
            }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int s) {}
            @Override public int getLoginTimeout() { return 100; }
            @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException {
                throw new UnsupportedOperationException();
            }
            @Override public <T> T unwrap(Class<T> iface) throws SQLException {
                throw new UnsupportedOperationException();
            }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };
    }

    // Thread-local or static accessor for current dbName (set by @Before in the test thread)
    private static volatile String currentDbNameHolder;
    private static String currentDbName() { return currentDbNameHolder; }

    @Before
    public void freshDb() throws Exception {
        // Each test gets its own uniquely-named in-memory Derby DB (starts empty)
        dbName = "engine-test-" + System.currentTimeMillis() + "-" + dbSeq.incrementAndGet();
        currentDbNameHolder = dbName;

        // Create the DB by opening (and closing) a connection with ;create=true
        DriverManager.getConnection("jdbc:derby:memory:" + dbName + ";create=true").close();

        // Open a long-lived connection for this test (DDL is autocommit by default in Derby)
        testConn = DriverManager.getConnection("jdbc:derby:memory:" + dbName + ";create=true");
    }

    @After
    public void dropDb() throws Exception {
        if (testConn != null && !testConn.isClosed()) testConn.close();
        if (dbName != null) {
            try {
                DriverManager.getConnection("jdbc:derby:memory:" + dbName + ";drop=true");
            } catch (SQLNonTransientConnectionException ignored) { /* expected on drop */ }
        }
    }

    @AfterClass
    public static void destroyShared() throws Exception {
        if (loader != null) loader.destroy();
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private SchemaMigrationEngine engine() {
        return new SchemaMigrationEngine(omdb, registry);
    }

    // ---------------------------------------------------------------------------
    // Test 1 — diff/verify/emit on an empty DB
    // ---------------------------------------------------------------------------

    @Test
    public void diffVerifyEmit_onEmptyDb() throws Exception {
        SchemaMigrationEngine engine = engine();

        // Diff against empty DB: should detect the missing "program" table
        DiffResult d = engine.diff(testConn, new AllowOptions());
        assertFalse("Expected non-empty diff against empty DB", d.isEmpty());

        // verify() returns true when drift exists
        assertTrue("verify() should report drift on empty DB",
            engine.verify(testConn, new AllowOptions()));

        // emit() should produce a CREATE TABLE statement
        EmitResult emitted = engine.emit(testConn, new AllowOptions());
        assertTrue("Emitted up script should contain CREATE TABLE",
            emitted.up().contains("CREATE TABLE"));
    }

    // ---------------------------------------------------------------------------
    // Test 2 — apply converges; round-trip clean
    // ---------------------------------------------------------------------------

    @Test
    public void apply_convergesSchema_roundTripClean() throws Exception {
        SchemaMigrationEngine engine = engine();

        // Before apply: drift exists
        assertTrue("Precondition: verify() should be true before apply",
            engine.verify(testConn, new AllowOptions()));

        // Apply: should execute CREATE TABLE program(...)
        engine.apply(testConn, new AllowOptions());

        // After apply: no drift
        assertFalse("verify() should be false after apply (schema converged)",
            engine.verify(testConn, new AllowOptions()));

        // Re-diff: empty
        assertTrue("diff() should be empty after apply",
            engine.diff(testConn, new AllowOptions()).isEmpty());

        // emit() after convergence: empty up script
        EmitResult emitted = engine.emit(testConn, new AllowOptions());
        assertEquals("emit() up script should be empty after convergence", "", emitted.up());
    }

    // ---------------------------------------------------------------------------
    // Test 3 — destructive change is surfaced and gated
    // ---------------------------------------------------------------------------

    @Test
    public void destructiveChange_surfacedAndGated() throws Exception {
        SchemaMigrationEngine engine = engine();

        // Converge first so "program" table exists
        engine.apply(testConn, new AllowOptions());
        assertFalse("Precondition: should be clean after initial apply",
            engine.verify(testConn, new AllowOptions()));

        // Manually add a column that metadata does not declare
        try (Statement s = testConn.createStatement()) {
            s.execute("ALTER TABLE program ADD COLUMN legacy VARCHAR(20)");
        }

        // Diff now sees one DROP_COLUMN (blocked by default)
        DiffResult d3 = engine.diff(testConn, new AllowOptions());
        assertEquals("Expected exactly 1 blocked change (drop-column legacy)",
            1, d3.blocked().size());

        // apply() without opt-in should throw BlockedChangesError
        try {
            engine.apply(testConn, new AllowOptions());
            fail("apply() should have thrown BlockedChangesError for blocked drop-column");
        } catch (BlockedChangesError expected) {
            // correct: refused
        }

        // apply() WITH explicit dropColumn opt-in should converge
        engine.apply(testConn, AllowOptions.builder().dropColumn(true).build());
        assertFalse("verify() should be false after apply with dropColumn=true",
            engine.verify(testConn, new AllowOptions()));
    }
}
