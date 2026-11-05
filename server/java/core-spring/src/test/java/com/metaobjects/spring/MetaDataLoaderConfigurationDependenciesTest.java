package com.metaobjects.spring;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * FR-023 S4 — a Spring app loads the committed dependency snapshot at runtime. {@code metaobjects:generate}
 * ships {@code .metaobjects/deps.lock.json} and {@code .metaobjects/deps/**} on the classpath; the lock's
 * presence is the trigger, and the load is verified exactly as the build-time path is (hash, lock/config
 * agreement, ownership) with the same error codes.
 *
 * <p>The classpath here is a temporary directory laid out like an app's jar (the snapshot comes from the
 * shared {@code fixtures/dependency-conformance} artifact), put on the thread context class loader the
 * resource resolution reads.</p>
 */
public class MetaDataLoaderConfigurationDependenciesTest {

    private static final String LOCK = """
            {"schema_version":1,"dependencies":{"acme-common":{"version":"1.0.0","metamodelVersion":"1.0",
            "resolvedFrom":{"path":"../acme-common/metaobjects"},"artifact":"acme-common.metaobjects.json",
            "integrity":"sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d",
            "packages":["acme::common"],"nodes":["acme::common::Address","acme::common::Audited","acme::common::Customer"]}}}
            """;
    private static final String CONFIG = """
            {"schema_version":1,"sources":[],"dependencies":[{"name":"acme-common","path":"../acme-common/metaobjects"}]}
            """;
    private static final String VIP = """
            {"metadata.root":{"package":"app","children":[{"object.entity":{"name":"Vip","extends":"acme::common::Audited",
            "children":[{"source.rdb":{"@table":"vips"}},{"field.long":{"name":"id"}},
            {"identity.primary":{"name":"pk","@fields":["id"]}}]}}]}}
            """;
    private static final String INTRUDER = """
            {"metadata.root":{"package":"acme::common","children":[{"object.value":{"name":"Note",
            "children":[{"field.string":{"name":"text"}}]}}]}}
            """;

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(
            MetaDataAutoConfiguration.class, ConfigurationPropertiesAutoConfiguration.class));

    private static Path artifact() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        return dir.resolve("fixtures/dependency-conformance/artifacts/acme-common-v1.json");
    }

    private static void write(Path path, String content) throws Exception {
        Files.createDirectories(path.getParent());
        Files.writeString(path, content, StandardCharsets.UTF_8);
    }

    /** An app's classpath root: its own metadata under {@code metadata/}, and what the build shipped. */
    private Path app(String ownMetadata, boolean lock, boolean snapshot, boolean config) throws Exception {
        Path root = tmp.newFolder().toPath();
        write(root.resolve("metadata/app.json"), ownMetadata);
        if (lock) write(root.resolve(".metaobjects/deps.lock.json"), LOCK);
        if (snapshot) {
            Path target = root.resolve(".metaobjects/deps/acme-common/acme-common.metaobjects.json");
            Files.createDirectories(target.getParent());
            Files.copy(artifact(), target);
        }
        if (config) write(root.resolve(".metaobjects/config.json"), CONFIG);
        return root;
    }

    private void run(Path root, Consumer<org.springframework.boot.test.context.assertj.AssertableApplicationContext> assertions)
            throws Exception {
        ClassLoader previous = Thread.currentThread().getContextClassLoader();
        try (URLClassLoader cl = new URLClassLoader(new URL[]{root.toUri().toURL()}, previous)) {
            Thread.currentThread().setContextClassLoader(cl);
            runner.withPropertyValues("metaobjects.metadata-sources=" + root.resolve("metadata/app.json").toUri())
                .run(assertions::accept);
        } finally {
            Thread.currentThread().setContextClassLoader(previous);
        }
    }

    private static ErrorCode codeOf(Throwable failure) {
        for (Throwable t = failure; t != null; t = t.getCause()) {
            if (t instanceof MetaDataException e && e.getCode().isPresent()) return e.getCode().get();
        }
        return null;
    }

    @Test
    public void anEntityExtendingAnImportedNodeBootsFromTheClasspathSnapshot() throws Exception {
        run(app(VIP, true, true, true), ctx -> {
            assertThat(ctx).hasNotFailed();
            MetaDataLoader loader = ctx.getBean(MetaDataLoader.class);
            // The snapshot loaded FIRST, so the project's own entity could extend it...
            assertThat(loader.getRoot().getDependencySet().imported("acme::common::Customer")).isTrue();
            assertThat(loader.getRoot().getDependencySet().imported("app::Vip")).isFalse();
            // ...and imported is load-only: it is not this project's to generate.
            assertThat(loader.getRoot().getDependencySet().inScope("acme::common::Customer")).isFalse();
            assertThat(loader.getRoot().getDependencySet().inScope("app::Vip")).isTrue();
        });
    }

    @Test
    public void theLockAloneIsEnoughWhenNoConfigIsOnTheClasspath() throws Exception {
        run(app(VIP, true, true, false), ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx.getBean(MetaDataLoader.class).getRoot().getDependencySet().isEmpty()).isFalse();
        });
    }

    @Test
    public void withNoLockOnTheClasspathNothingChanges() throws Exception {
        String plain = """
                {"metadata.root":{"package":"app","children":[{"object.entity":{"name":"Order","children":[
                {"source.rdb":{"@table":"orders"}},{"field.long":{"name":"id"}},
                {"identity.primary":{"name":"pk","@fields":["id"]}}]}}]}}
                """;
        run(app(plain, false, false, false), ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx.getBean(MetaDataLoader.class).getRoot().getDependencySet().isEmpty()).isTrue();
        });
    }

    @Test
    public void aSnapshotThatNoLongerMatchesTheLockFailsBootAsStale() throws Exception {
        Path root = app(VIP, true, true, true);
        Files.writeString(root.resolve(".metaobjects/deps/acme-common/acme-common.metaobjects.json"),
                Files.readString(artifact()) + " ", StandardCharsets.UTF_8);
        run(root, ctx -> {
            assertThat(ctx).hasFailed();
            assertThat(codeOf(ctx.getStartupFailure())).isEqualTo(ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE);
        });
    }

    @Test
    public void aMissingSnapshotFailsBootAsStale() throws Exception {
        run(app(VIP, true, false, true), ctx -> {
            assertThat(ctx).hasFailed();
            assertThat(codeOf(ctx.getStartupFailure())).isEqualTo(ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE);
        });
    }

    @Test
    public void aConfigDeclaringDependenciesWithNoLockFailsBootAsStale() throws Exception {
        run(app(VIP, false, false, true), ctx -> {
            assertThat(ctx).hasFailed();
            assertThat(codeOf(ctx.getStartupFailure())).isEqualTo(ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE);
        });
    }

    @Test
    public void aNodeDeclaredIntoADependencysPackageIsRefused() throws Exception {
        run(app(INTRUDER, true, true, true), ctx -> {
            assertThat(ctx).hasFailed();
            assertThat(codeOf(ctx.getStartupFailure())).isEqualTo(ErrorCode.ERR_DEPENDENCY_PACKAGE_NOT_OWNED);
        });
    }
}
