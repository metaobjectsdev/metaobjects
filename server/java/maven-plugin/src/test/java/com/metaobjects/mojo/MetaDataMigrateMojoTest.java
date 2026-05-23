package com.metaobjects.mojo;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.file.FileLoaderOptions;
import com.metaobjects.loader.file.FileMetaDataLoader;
import com.metaobjects.loader.file.LocalFileMetaDataSources;
import org.apache.maven.plugin.MojoExecutionException;
import org.codehaus.plexus.PlexusTestCase;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.SQLNonTransientConnectionException;

import static org.junit.Assert.*;

/**
 * Integration test for MetaDataMigrateMojo (verb = emit).
 *
 * <p>Because the mojo's {@code createLoader(createProjectClassLoader())} requires a real
 * {@link org.apache.maven.project.MavenProject} context that the maven-plugin-testing-harness
 * cannot trivially provide for a mojo with JDBC + engine wiring, this test uses a
 * <em>focused direct-instantiation</em> approach: it subclasses {@code MetaDataMigrateMojo},
 * overrides {@code createLoader} to build a {@link FileMetaDataLoader} from the test fixture
 * without touching the Maven classpath machinery, and drives the engine end-to-end against an
 * in-memory Derby database. The {@code SchemaMigrationEngine} and {@code DerbyDriver} are the
 * real implementations — nothing is mocked or faked.
 */
public class MetaDataMigrateMojoTest {

    /** Unique in-memory Derby DB name for this test run. */
    private String dbName;

    @Before
    public void setUp() throws Exception {
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        dbName = "mojo-test-" + System.currentTimeMillis();
        // Create the DB
        DriverManager.getConnection("jdbc:derby:memory:" + dbName + ";create=true").close();
    }

    @After
    public void tearDown() throws Exception {
        try {
            DriverManager.getConnection("jdbc:derby:memory:" + dbName + ";drop=true");
        } catch (SQLNonTransientConnectionException ignored) { /* expected on drop */ }
    }

    // -------------------------------------------------------------------------
    // Test subclass — overrides createLoader to bypass Maven project classpath
    // -------------------------------------------------------------------------

    /**
     * Extends the real mojo but overrides only the loader construction so the
     * test can supply metadata via a file path rather than a Maven project classpath.
     */
    static class TestableMigrateMojo extends MetaDataMigrateMojo {

        /** Directory containing the fixture file (used as the sourceDir). */
        private final String fixtureDir;
        /** Filename within {@code fixtureDir}. */
        private final String fixtureFile;

        TestableMigrateMojo(String fixtureDir, String fixtureFile) {
            this.fixtureDir  = fixtureDir;
            this.fixtureFile = fixtureFile;
        }

        /**
         * Bypass {@code MetaDataMigrateMojo.createLoader} (needs loaderConfig + MavenProject).
         * Uses a {@link FileMetaDataLoader} that reads directly from the filesystem via
         * {@code LocalFileMetaDataSources(sourceDir, filename)}.
         */
        @Override
        protected MetaDataLoader createLoader(ClassLoader ignored) {
            try {
                FileMetaDataLoader xl = new FileMetaDataLoader(
                    new FileLoaderOptions()
                        .setShouldRegister(false)
                        .setAllowAutoAttrs(true)
                        .setStrict(false)
                        .setVerbose(false),
                    "mojo-test-loader");
                // LocalFileMetaDataSources(baseDir, filename) → getFileInputStream(baseDir + "/" + filename)
                xl.init(new LocalFileMetaDataSources(fixtureDir, fixtureFile));
                xl.register();
                return xl;
            } catch (Exception e) {
                throw new RuntimeException("Could not build test loader: " + e.getMessage(), e);
            }
        }

        /** Bypass Maven project classpath (not available in unit-test context). */
        @Override
        protected ClassLoader createProjectClassLoader() {
            return getClass().getClassLoader();
        }
    }

    // -------------------------------------------------------------------------
    // Helper: inject private @Parameter fields via reflection
    // -------------------------------------------------------------------------

    private static void setField(Object target, String name, Object value) throws Exception {
        // Walk up the class hierarchy to find the declared field
        Class<?> cls = target.getClass();
        while (cls != null) {
            try {
                Field f = cls.getDeclaredField(name);
                f.setAccessible(true);
                f.set(target, value);
                return;
            } catch (NoSuchFieldException e) {
                cls = cls.getSuperclass();
            }
        }
        throw new NoSuchFieldException("Field '" + name + "' not found in " + target.getClass().getName());
    }

    // -------------------------------------------------------------------------
    // Test: verb=emit writes up.sql containing CREATE TABLE
    // -------------------------------------------------------------------------

    @Test
    public void emit_writesUpSqlWithCreateTable() throws Exception {
        // Resolve fixture path — the file is in src/test/resources/mojo/
        File resourcesDir = new File(PlexusTestCase.getBasedir(), "src/test/resources/mojo");
        assertTrue("Test fixture dir must exist: " + resourcesDir, resourcesDir.exists());

        // Output dir under target so it is gitignored
        Path outputDir = Path.of(PlexusTestCase.getBasedir(), "target", "mojo-migrate-test");

        TestableMigrateMojo mojo = new TestableMigrateMojo(
            resourcesDir.getAbsolutePath(), "meta.migrate-test.json");

        setField(mojo, "verb",           "emit");
        setField(mojo, "jdbcUrl",        "jdbc:derby:memory:" + dbName + ";create=true");
        setField(mojo, "jdbcUser",       null);
        setField(mojo, "jdbcPassword",   null);
        setField(mojo, "jdbcDriver",     "org.apache.derby.jdbc.EmbeddedDriver");
        setField(mojo, "databaseDriver", "com.metaobjects.manager.db.driver.DerbyDriver");
        setField(mojo, "outputDir",      outputDir.toString());
        setField(mojo, "slug",           "widget-init");
        setField(mojo, "allowDropColumn",false);
        setField(mojo, "allowDropTable", false);
        setField(mojo, "allowTypeChange",false);

        // Execute: must not throw
        mojo.execute();

        // Assert: a timestamped sub-directory containing up.sql was created
        File[] dirs = outputDir.toFile().listFiles(File::isDirectory);
        assertNotNull("outputDir should have been created", dirs);
        assertTrue("Expected at least one migration sub-directory under " + outputDir,
            dirs.length > 0);

        boolean foundCreateTable = false;
        for (File dir : dirs) {
            File upSql = new File(dir, "up.sql");
            if (upSql.exists()) {
                String content = Files.readString(upSql.toPath());
                if (content.toUpperCase().contains("CREATE TABLE")) {
                    foundCreateTable = true;
                    break;
                }
            }
        }
        assertTrue("up.sql must contain CREATE TABLE statement", foundCreateTable);
    }

    // -------------------------------------------------------------------------
    // Test: unknown verb throws MojoExecutionException
    // -------------------------------------------------------------------------

    @Test
    public void unknownVerb_throwsMojoExecutionException() throws Exception {
        File resourcesDir = new File(PlexusTestCase.getBasedir(), "src/test/resources/mojo");

        TestableMigrateMojo mojo = new TestableMigrateMojo(
            resourcesDir.getAbsolutePath(), "meta.migrate-test.json");

        setField(mojo, "verb",           "explode");
        setField(mojo, "jdbcUrl",        "jdbc:derby:memory:" + dbName + ";create=true");
        setField(mojo, "jdbcUser",       null);
        setField(mojo, "jdbcPassword",   null);
        setField(mojo, "jdbcDriver",     "org.apache.derby.jdbc.EmbeddedDriver");
        setField(mojo, "databaseDriver", "com.metaobjects.manager.db.driver.DerbyDriver");
        setField(mojo, "outputDir",      Path.of(PlexusTestCase.getBasedir(), "target", "mojo-migrate-test-unknown").toString());
        setField(mojo, "slug",           "test");
        setField(mojo, "allowDropColumn",false);
        setField(mojo, "allowDropTable", false);
        setField(mojo, "allowTypeChange",false);

        try {
            mojo.execute();
            fail("Expected MojoExecutionException for unknown verb");
        } catch (MojoExecutionException e) {
            assertTrue("Exception message should mention the unknown verb",
                e.getMessage().contains("explode"));
        }
    }
}
