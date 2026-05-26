package com.metaobjects.manager.db.migrate;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.driver.PostgresDriver;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.ViewDescriptor;
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
 * Integration-style test verifying the migration engine emits {@code CREATE VIEW}
 * SQL for entities with {@code source.rdb @kind: "view"} (source-v2; the legacy
 * {@code source.dbView} subtype was retired with ADR-0007).
 *
 * <p>The pipeline exercised end-to-end:
 * <ol>
 *   <li>Load the fixture into a {@link MetaDataLoader}.</li>
 *   <li>Build the expected {@link SchemaSnapshot} via {@link ExpectedSchemaBuilder}
 *       — its second pass walks projection entities and invokes
 *       {@link ViewBodyBuilder#buildSql} to derive view bodies from
 *       {@code origin.passthrough} children.</li>
 *   <li>Diff against an empty actual snapshot via {@link SchemaDiffer} — any
 *       expected view that doesn't exist in actual becomes a
 *       {@link Change.CreateView}.</li>
 *   <li>{@link MigrationEmitter} composes the up script using
 *       {@link PostgresDriver}'s rendering, which emits
 *       {@code CREATE OR REPLACE VIEW}.</li>
 * </ol>
 *
 * <p>Setup mirrors {@link ExpectedSchemaBuilderTest} — Derby in-memory backing
 * for {@link ObjectManagerDB}, then validator init to prime mapping caches.
 * Render is via Postgres because Postgres is the documented projection target
 * (Derby's render for {@code CreateView} is also supported but Postgres is the
 * documented target).</p>
 */
public class ViewMigrationTest {

    private static ObjectManagerDB omdb;
    private static String dbFile;
    private static MetaDataLoader loader;
    private static MetaDataLoaderRegistry registry;

    @BeforeClass
    public static void setupDB() throws Exception {
        registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());

        MetaDataLoader xl = MetaDataLoader.fromResources(
            "test-view-migration", java.util.List.of("meta.view-migration.json"));
        registry.registerLoader(xl);
        loader = xl;

        dbFile = "view-migration-" + System.currentTimeMillis();
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        getConnection().close();

        DataSource ds = new DataSource() {
            @Override public Connection getConnection() throws SQLException { return ViewMigrationTest.getConnection(); }
            @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
            @Override public PrintWriter getLogWriter() { return new PrintWriter(System.out); }
            @Override public void setLogWriter(PrintWriter out) {}
            @Override public void setLoginTimeout(int s) {}
            @Override public int getLoginTimeout() { return 100; }
            @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException { throw new UnsupportedOperationException(); }
            @Override public <T> T unwrap(Class<T> iface) { throw new UnsupportedOperationException(); }
            @Override public boolean isWrapperFor(Class<?> iface) { return false; }
        };

        omdb = new ObjectManagerDB();
        omdb.setDatabaseDriver(new DerbyDriver());
        omdb.setDataSource(ds);
        omdb.init();

        // Prime MappingHandler caches (same pattern as the other DB tests).
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
    public void expectedSnapshotContainsViewDescriptor() {
        SchemaSnapshot snap = new ExpectedSchemaBuilder(omdb, registry).build(RenameHints.empty());

        Optional<ViewDescriptor> viewOpt = snap.views().stream()
            .filter(v -> "v_author_summary".equalsIgnoreCase(v.name()))
            .findFirst();
        assertTrue("expected a 'v_author_summary' view in the snapshot; views="
            + snap.views(), viewOpt.isPresent());
        // ViewBodyBuilder lowers origin.passthrough into "SELECT ... AS ... FROM ..."
        String body = viewOpt.get().sql();
        assertNotNull("expected non-null view body SQL", body);
        assertTrue("view body should be a SELECT; saw:\n" + body,
            body.toUpperCase().contains("SELECT"));
    }

    @Test
    public void emitsCreateViewSqlForViewKind() {
        // Build the expected snapshot from metadata.
        SchemaSnapshot expected = new ExpectedSchemaBuilder(omdb, registry).build(RenameHints.empty());
        // Diff against an empty actual snapshot — the view should become a CreateView change.
        SchemaSnapshot actual = new SchemaSnapshot(java.util.List.of(), java.util.List.of());
        DiffResult diff = new SchemaDiffer().diff(expected, actual, new AllowOptions(), RenameHints.empty());
        // Emit through the Postgres renderer.
        EmitResult emit = new MigrationEmitter(new PostgresDriver()).emit(diff);
        String up = emit.up();
        assertTrue("up script should contain CREATE ... VIEW for the @kind:view entity; saw:\n" + up,
            up.contains("CREATE") && up.contains("VIEW"));
        assertTrue("up script should reference the view's physical name; saw:\n" + up,
            up.contains("v_author_summary"));
    }
}
