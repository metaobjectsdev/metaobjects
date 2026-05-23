package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.MigrationSqlRenderer;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.registry.MetaDataLoaderRegistry;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Decoupled diff-and-converge engine (FR-003 §4). Builds the expected snapshot from metadata,
 * introspects the live DB, diffs, and exposes diff/verify/emit/apply. Nothing applied on construction.
 *
 * <p>This engine is intentionally decoupled from {@code MetaClassDBValidatorService} — it is the
 * schema authority itself. It takes a JDBC {@link Connection} so a caller can pass either a pooled
 * or a Spring-tx-bound connection. DDL executes via {@link Statement#execute} (correct for DDL —
 * not {@code ObjectManagerDB.execute}, which is for DML).
 */
public final class SchemaMigrationEngine {
    private final ObjectManagerDB manager;
    private final MetaDataLoaderRegistry loaderRegistry;
    private final SchemaIntrospector introspector = new SchemaIntrospector();
    private final SchemaDiffer differ = new SchemaDiffer();

    public SchemaMigrationEngine(ObjectManagerDB manager, MetaDataLoaderRegistry loaderRegistry) {
        this.manager = manager;
        this.loaderRegistry = loaderRegistry;
    }

    /** The (deterministic) change list to bring the live DB to match metadata. */
    public DiffResult diff(Connection c, AllowOptions allow) throws SQLException {
        RenameHints hints = new RenameHints();
        SchemaSnapshot expected = new ExpectedSchemaBuilder(manager, loaderRegistry).build(hints);
        SchemaSnapshot actual = introspector.introspect(c, null);
        return differ.diff(expected, actual, allow, hints);
    }

    /** Drift gate: true when the schema diverges (CI maps true -> non-zero exit). */
    public boolean verify(Connection c, AllowOptions allow) throws SQLException {
        return !diff(c, allow).isEmpty();
    }

    /** Forward-only {@code up} script (throws {@link BlockedChangesError} if any change is blocked). */
    public EmitResult emit(Connection c, AllowOptions allow) throws SQLException {
        return new MigrationEmitter(renderer()).emit(diff(c, allow));
    }

    /** Execute the changes (throws {@link BlockedChangesError} before running anything if any is blocked). */
    public void apply(Connection c, AllowOptions allow) throws SQLException {
        DiffResult d = diff(c, allow);
        if (!d.blocked().isEmpty()) throw new BlockedChangesError(d.blocked());
        MigrationSqlRenderer r = renderer();
        try (Statement s = c.createStatement()) {     // DDL: Statement.execute (not ObjectManagerDB.execute)
            for (Change ch : d.changes()) s.execute(r.render(ch));
        }
    }

    private MigrationSqlRenderer renderer() { return (MigrationSqlRenderer) manager.getDatabaseDriver(); }
}
