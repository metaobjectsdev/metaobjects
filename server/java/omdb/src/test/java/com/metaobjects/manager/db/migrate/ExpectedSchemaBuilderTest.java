package com.metaobjects.manager.db.migrate;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.file.FileLoaderOptions;
import com.metaobjects.loader.file.FileMetaDataLoader;
import com.metaobjects.loader.file.LocalFileMetaDataSources;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.ColumnDescriptor;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.TableDescriptor;
import com.metaobjects.manager.db.validator.MetaClassDBValidatorService;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;

import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.*;
import java.util.Optional;
import java.util.logging.Logger;

import static org.junit.Assert.*;

/**
 * TDD test for ExpectedSchemaBuilder: verifies that metadata-derived SchemaSnapshot
 * contains the correct tables, column types, and that @previousName is harvested into
 * RenameHints. Uses Derby in-memory + FileMetaDataLoader exactly as JsonbFieldDBTest does.
 */
public class ExpectedSchemaBuilderTest {

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());

        FileMetaDataLoader xl = new FileMetaDataLoader(
            new FileLoaderOptions()
                .setShouldRegister(false)
                .setAllowAutoAttrs(true)
                .setStrict(false)
                .setVerbose(false),
            "test-expected-db");

        xl.init(new LocalFileMetaDataSources("meta.expected.json"));
        xl.register();
        registry.registerLoader(xl);
        loader = xl;

        dbFile = "expected-testing-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return ExpectedSchemaBuilderTest.getConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() throws SQLException { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) throws SQLException {}
            @Override public void setLoginTimeout(int s) throws SQLException {}
            @Override public int getLoginTimeout() throws SQLException { return 100; }
            @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) throws SQLException { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) throws SQLException { return false; }
        };

        omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(ds);
        omdb.init();

        // Run the validator so MappingHandler caches are primed (same as other DB tests)
        MetaClassDBValidatorService vs = new MetaClassDBValidatorService();
        vs.setObjectManager(omdb);
        vs.setAutoCreate(true);
        vs.setMetaDataLoaderRegistry(registry);
        vs.init();
    }

    private static Connection getConnection() throws SQLException {
        return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
    }

    @AfterClass
    public static void destroyDB() throws Exception {
        if (dbFile != null) {
            try { DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true"); }
            catch (SQLNonTransientConnectionException ignored) {}
        }
        if (loader != null) loader.destroy();
    }

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------

    @Test
    public void buildsTableDescriptorFromMetadata() {
        RenameHints hints = RenameHints.empty();
        SchemaSnapshot snap = new ExpectedSchemaBuilder(omdb, registry).build(hints);

        // Locate the "program" table (case-insensitive)
        Optional<TableDescriptor> programOpt = snap.tables().stream()
            .filter(t -> "program".equalsIgnoreCase(t.name()))
            .findFirst();
        assertTrue("Expected a 'program' table in the snapshot", programOpt.isPresent());
        TableDescriptor program = programOpt.get();

        // id column: field.long -> BIGINT -> Int(64)
        ColumnDescriptor id = column(program, "id");
        assertNotNull("Expected column 'id' in program table", id);
        assertEquals("id column should be Int(64)", new SqlType.Int(64), id.sqlType());
        assertTrue("id should be in the primary key list",
            program.primaryKey().stream().anyMatch(c -> "id".equalsIgnoreCase(c)));

        // title column: field.string -> VARCHAR(50) -> Text(50)
        // getSQLLength for STRING returns fixed 50 regardless of @dbLength (known limitation, see spec note)
        ColumnDescriptor title = column(program, "title");
        assertNotNull("Expected column 'title' in program table", title);
        assertEquals("title column should be Text(50)", new SqlType.Text(50), title.sqlType());
    }

    @Test
    public void harvestsPreviousNameAsRenameHint() {
        RenameHints hints = RenameHints.empty();
        new ExpectedSchemaBuilder(omdb, registry).build(hints);

        // @previousName: "name" on the title field -> rename hint on column "title" in table "program"
        assertEquals("title column should have previousName 'name'",
            "name", hints.previousColumn("program", "title"));
    }

    @Test
    public void emptyHintsWhenNoPreviousName() {
        RenameHints hints = RenameHints.empty();
        new ExpectedSchemaBuilder(omdb, registry).build(hints);

        // id has no @previousName
        assertNull("id column should have no previousName",
            hints.previousColumn("program", "id"));
        // no table-level rename
        assertNull("program table should have no previousName",
            hints.previousTable("program"));
    }

    // -------------------------------------------------------------------------
    // Utility
    // -------------------------------------------------------------------------

    private static ColumnDescriptor column(TableDescriptor table, String name) {
        return table.columns().stream()
            .filter(c -> name.equalsIgnoreCase(c.name()))
            .findFirst()
            .orElse(null);
    }
}
