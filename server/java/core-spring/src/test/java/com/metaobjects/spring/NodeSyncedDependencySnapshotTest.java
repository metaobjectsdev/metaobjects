package com.metaobjects.spring;

import com.metaobjects.config.Dependencies;
import com.metaobjects.config.NeutralConfig;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * FR-023 S4/S5 end to end against what the Node toolchain actually writes. The Node {@code meta deps sync}
 * is the only writer of the lock and the snapshot (recorded decision), so the Java side must read ITS
 * output, not a lock this repo hand-wrote to match the Java reader.
 *
 * <p>Fixture {@code node-deps-sync/} (test resources): {@code publisher/acme-common/} is a {@code path}
 * dependency — the shared corpus artifact {@code fixtures/dependency-conformance/artifacts/acme-common-v1.json}
 * plus its {@code metaobjects.pkg.json}. {@code app/.metaobjects/deps.lock.json} and
 * {@code app/.metaobjects/deps/**} are the unedited output of running, in {@code app/},
 * {@code bun <repo-root>/server/typescript/packages/cli/bin/meta.ts deps sync}. Regenerate them the same
 * way; never edit them by hand. The fixture sits under a subdirectory so its lock is not on the test
 * classpath of every other test in this module.</p>
 */
public class NodeSyncedDependencySnapshotTest {

    private static Path app() throws Exception {
        URL config = NodeSyncedDependencySnapshotTest.class.getClassLoader()
                .getResource("node-deps-sync/app/.metaobjects/config.json");
        assertThat(config).as("node-deps-sync fixture on the test classpath").isNotNull();
        return Paths.get(config.toURI()).getParent().getParent();
    }

    @Test
    public void theDepsCheckReportsTheNodeSyncedLockCurrent() throws Exception {
        Path app = app();
        NeutralConfig config = NeutralConfig.read(app).orElseThrow();
        Optional<Map<String, Dependencies.LockEntry>> lock = Dependencies.readLock(app);
        assertThat(lock).isPresent();

        List<Dependencies.CheckResult> results = Dependencies.check(app, config.getDependencies(), lock);

        // Oracle: the Node `meta deps check` over this same tree reports `acme-common: current — 1.0.0 (10fbf886)`,
        // and 10fbf886… is the sha256 of the corpus artifact the publisher ships.
        assertThat(results).hasSize(1);
        assertThat(results.get(0).status()).isEqualTo(Dependencies.CheckStatus.CURRENT);
        assertThat(results.get(0).line()).isEqualTo("acme-common: current — 1.0.0 (10fbf886)");
    }

    @Test
    public void aSpringAppBootsFromTheNodeSyncedSnapshot() throws Exception {
        Path app = app();
        ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(
                MetaDataAutoConfiguration.class, ConfigurationPropertiesAutoConfiguration.class));
        ClassLoader previous = Thread.currentThread().getContextClassLoader();
        try (URLClassLoader cl = new URLClassLoader(new URL[]{app.toUri().toURL()}, previous)) {
            Thread.currentThread().setContextClassLoader(cl);
            runner.withPropertyValues("metaobjects.metadata-sources=" + app.resolve("metadata/app.json").toUri())
                .run(ctx -> {
                    assertThat(ctx).hasNotFailed();
                    MetaDataLoader loader = ctx.getBean(MetaDataLoader.class);
                    // app::Vip extends acme::common::Audited, which only the snapshot declares: the load
                    // resolving it is the proof the snapshot was read, and read first.
                    assertThat(loader.getMetaObjectByName("app::Vip")).isNotNull();
                    assertThat(loader.getRoot().getDependencySet().imported("acme::common::Audited")).isTrue();
                    assertThat(loader.getRoot().getDependencySet().inScope("acme::common::Audited")).isFalse();
                    assertThat(loader.getRoot().getDependencySet().inScope("app::Vip")).isTrue();
                });
        } finally {
            Thread.currentThread().setContextClassLoader(previous);
        }
    }
}
