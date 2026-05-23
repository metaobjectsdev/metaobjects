package com.metaobjects.mojo;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.DatabaseDriver;           // com.metaobjects.manager.db, NOT ...db.driver
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.migrate.AllowOptions;
import com.metaobjects.manager.db.migrate.BlockedChangesError;
import com.metaobjects.manager.db.migrate.Change;
import com.metaobjects.manager.db.migrate.DiffResult;
import com.metaobjects.manager.db.migrate.EmitResult;
import com.metaobjects.manager.db.migrate.SchemaMigrationEngine;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.project.MavenProject;

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/**
 * Diff-and-converge schema migration mojo (FR-003 §4).
 *
 * <p>Supports four verbs:</p>
 * <ul>
 *   <li>{@code diff}   — log changes to bring the live DB in sync with metadata</li>
 *   <li>{@code verify} — fail the build if schema drift is detected (CI gate)</li>
 *   <li>{@code emit}   — write a forward-only {@code up.sql} migration script</li>
 *   <li>{@code apply}  — execute the migration directly against the live DB</li>
 * </ul>
 *
 * <p>Destructive operations ({@code DROP COLUMN}, {@code DROP TABLE}, type changes) are
 * blocked by default and must be explicitly opted in via the {@code allowDrop*} /
 * {@code allowTypeChange} parameters.</p>
 *
 * <p>This mojo extends {@link AbstractMojo} directly (not the codegen-oriented
 * {@code AbstractMetaDataMojo}) because the migration mojo has no codegen generators and
 * needs to declare {@code MojoFailureException} on {@code execute()} for schema-drift
 * signalling — a check that the codegen base class narrows away.</p>
 */
@Mojo(name = "migrate")
public class MetaDataMigrateMojo extends AbstractMojo {

    /** Migration verb: {@code diff} | {@code verify} | {@code emit} | {@code apply}. */
    @Parameter(property = "verb", defaultValue = "diff")
    private String verb;

    /** JDBC connection URL (required). */
    @Parameter(property = "jdbcUrl", required = true)
    private String jdbcUrl;

    /** JDBC username (optional). */
    @Parameter(property = "jdbcUser")
    private String jdbcUser;

    /** JDBC password (optional). */
    @Parameter(property = "jdbcPassword")
    private String jdbcPassword;

    /**
     * Fully qualified JDBC driver class to load before connecting.
     * Optional if the driver is already on the classpath and registers itself via ServiceLoader.
     */
    @Parameter(property = "jdbcDriver")
    private String jdbcDriver;

    /**
     * Fully qualified class name of the {@link DatabaseDriver} implementation.
     * Defaults to the PostgreSQL driver; override with
     * {@code com.metaobjects.manager.db.driver.DerbyDriver} for Derby.
     */
    @Parameter(property = "databaseDriver",
               defaultValue = "com.metaobjects.manager.db.driver.PostgresDriver")
    private String databaseDriver;

    /** Base directory for emitted migration scripts (verb={@code emit} only). */
    @Parameter(property = "outputDir",
               defaultValue = "${project.build.directory}/migrations")
    private String outputDir;

    /**
     * Human-readable slug appended to the timestamped migration directory name
     * (verb={@code emit} only).
     */
    @Parameter(property = "slug", defaultValue = "migrate")
    private String slug;

    /** Opt-in: allow {@code DROP COLUMN} operations. */
    @Parameter(property = "allowDropColumn", defaultValue = "false")
    private boolean allowDropColumn;

    /** Opt-in: allow {@code DROP TABLE} operations. */
    @Parameter(property = "allowDropTable", defaultValue = "false")
    private boolean allowDropTable;

    /** Opt-in: allow column type-change operations. */
    @Parameter(property = "allowTypeChange", defaultValue = "false")
    private boolean allowTypeChange;

    /**
     * Metadata loader configuration (mirrors {@code AbstractMetaDataMojo}'s {@code <loader>}
     * element).
     */
    @Parameter(name = "loader")
    private LoaderParam loaderConfig;

    @Parameter(defaultValue = "${project}", readonly = true, required = true)
    private MavenProject project;

    // -------------------------------------------------------------------------
    // execute
    // -------------------------------------------------------------------------

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        try {
            // Load the JDBC driver class if explicitly configured
            if (jdbcDriver != null && !jdbcDriver.isBlank()) {
                Class.forName(jdbcDriver);
            }

            // Build the ObjectManagerDB with the requested database driver
            ObjectManagerDB manager = new ObjectManagerDB();
            manager.setDatabaseDriver(
                (DatabaseDriver) Class.forName(databaseDriver)
                    .getDeclaredConstructor().newInstance());

            // Build AllowOptions from mojo parameters
            AllowOptions allow = AllowOptions.builder()
                .dropColumn(allowDropColumn)
                .dropTable(allowDropTable)
                .typeChange(allowTypeChange)
                .build();

            // Build loader + wrap in registry (mirrors AbstractOMDBTest wiring).
            // AbstractMetaDataMojo is not extended here; we reproduce its two helper methods.
            MetaDataLoader loader = createLoader(createProjectClassLoader());
            MetaDataLoaderRegistry registry =
                new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
            registry.registerLoader(loader);

            try (Connection c = DriverManager.getConnection(jdbcUrl, jdbcUser, jdbcPassword)) {
                SchemaMigrationEngine engine = new SchemaMigrationEngine(manager, registry);
                switch (verb) {
                    case "diff"   -> runDiff(engine, c, allow);
                    case "verify" -> runVerify(engine, c, allow);
                    case "emit"   -> runEmit(engine, c, allow);
                    case "apply"  -> runApply(engine, c, allow);
                    default -> throw new MojoExecutionException(
                        "Unknown verb: " + verb + " — expected one of: diff, verify, emit, apply");
                }
            }
        } catch (MojoFailureException | MojoExecutionException e) {
            throw e;
        } catch (BlockedChangesError e) {
            throw new MojoFailureException(e.getMessage(), e);
        } catch (Exception e) {
            throw new MojoExecutionException(
                "Migration verb '" + verb + "' failed: " + e.getMessage(), e);
        }
    }

    // -------------------------------------------------------------------------
    // Verb implementations
    // -------------------------------------------------------------------------

    private void runDiff(SchemaMigrationEngine engine, Connection c, AllowOptions allow)
            throws Exception {
        DiffResult result = engine.diff(c, allow);
        List<Change> changes = result.changes();
        if (changes.isEmpty()) {
            getLog().info("Schema in sync — no changes required.");
        } else {
            getLog().info("Schema diff (" + changes.size() + " change(s)):");
            for (Change ch : changes) {
                String blocked = "blocked".equals(ch.status().state())
                    ? "  [BLOCKED: " + ch.status().blockedReason() + "]"
                    : "";
                getLog().info("  " + ch.kind() + "  " + ch.sortKey() + blocked);
            }
        }
    }

    private void runVerify(SchemaMigrationEngine engine, Connection c, AllowOptions allow)
            throws Exception {
        if (engine.verify(c, allow)) {
            throw new MojoFailureException(
                "Schema drift detected. Run 'meta migrate -Dverb=diff' for details.");
        }
        getLog().info("Schema in sync — no drift.");
    }

    private void runEmit(SchemaMigrationEngine engine, Connection c, AllowOptions allow)
            throws Exception {
        EmitResult result = engine.emit(c, allow);
        String up = result.up();
        if (up == null || up.isBlank()) {
            getLog().info("Nothing to emit — schema is already in sync.");
            return;
        }
        Path dir = Path.of(outputDir, timestamp() + "-" + sanitize(slug));
        Files.createDirectories(dir);
        String content = up.endsWith("\n") ? up : up + "\n";
        Files.writeString(dir.resolve("up.sql"), content);
        getLog().info("Wrote migration script: " + dir.resolve("up.sql"));
    }

    private void runApply(SchemaMigrationEngine engine, Connection c, AllowOptions allow)
            throws Exception {
        engine.apply(c, allow);
        getLog().info("Migration applied successfully.");
    }

    // -------------------------------------------------------------------------
    // Loader helpers (port of AbstractMetaDataMojo's two protected methods)
    // -------------------------------------------------------------------------

    /**
     * Creates a {@link MetaDataLoader} from the configured {@code <loader>} element.
     * Reproduces the essential subset of {@link AbstractMetaDataMojo#createLoader}.
     */
    protected MetaDataLoader createLoader(ClassLoader projectClassLoader) {
        if (loaderConfig == null) {
            throw new MetaDataException("No <loader> element was defined in the migrate mojo configuration");
        }
        com.metaobjects.loader.LoaderConfigurable configurable;
        String loaderClass = loaderConfig.getClassname();
        String loaderName  = loaderConfig.getName();

        if (loaderClass != null) {
            try {
                Class<?> c = projectClassLoader.loadClass(loaderClass);
                java.lang.reflect.Constructor<?> cc = c.getDeclaredConstructor(String.class);
                configurable = (com.metaobjects.loader.LoaderConfigurable) cc.newInstance(loaderName);
            } catch (Exception e) {
                throw new MetaDataException(
                    "Could not instantiate loader class [" + loaderClass + "]: " + e.getMessage(), e);
            }
        } else {
            configurable = new MetaDataLoader(
                com.metaobjects.loader.LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, loaderName);
        }

        MavenLoaderConfiguration.configure(
            configurable,
            loaderConfig.getSourceDir(),
            projectClassLoader,
            loaderConfig.getSources(),
            null);

        return configurable.getLoader();
    }

    /**
     * Builds a {@link ClassLoader} from the Maven project's runtime + compile classpaths.
     * Falls back to the plugin's own classloader when running outside a Maven lifecycle
     * (e.g., in unit tests where {@link #project} is null).
     */
    protected ClassLoader createProjectClassLoader() {
        ClassLoader base = getClass().getClassLoader();
        if (project == null) return base;
        try {
            List<String> elements = new ArrayList<>();
            elements.addAll(project.getRuntimeClasspathElements());
            elements.addAll(project.getCompileClasspathElements());
            if (elements.isEmpty()) return base;
            URL[] urls = new URL[elements.size()];
            for (int i = 0; i < elements.size(); i++) {
                urls[i] = new File(elements.get(i)).toURI().toURL();
            }
            return new URLClassLoader(urls, base);
        } catch (Exception e) {
            throw new MetaDataException(
                "Error building project class loader: " + e.getMessage(), e);
        }
    }

    // -------------------------------------------------------------------------
    // Utility
    // -------------------------------------------------------------------------

    private static String timestamp() {
        return ZonedDateTime.now(ZoneOffset.UTC)
            .format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss"));
    }

    private static String sanitize(String raw) {
        return raw.toLowerCase()
            .replaceAll("[^a-z0-9]+", "-")
            .replaceAll("^-+|-+$", "");
    }
}
