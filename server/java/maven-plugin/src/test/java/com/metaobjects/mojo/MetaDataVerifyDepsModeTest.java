package com.metaobjects.mojo;

import com.metaobjects.config.Dependencies;
import org.apache.maven.plugin.MojoFailureException;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collections;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR-023 S5 — {@code metaobjects:verify -Dmeta.verify.mode=deps}: the Java/Kotlin counterpart of
 * {@code meta deps check} / {@code verify --deps}. The shared corpus arm
 * ({@code DependencyCheckConformanceTest}) pins the statuses; these tests pin the goal around it: mode
 * dispatch, the report, and what fails the build.
 */
public class MetaDataVerifyDepsModeTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static Path artifact(String name) {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        return dir.resolve("fixtures/dependency-conformance/artifacts/" + name);
    }

    private static void write(Path path, String content) throws Exception {
        Files.createDirectories(path.getParent());
        Files.writeString(path, content, StandardCharsets.UTF_8);
    }

    /** A project beside its publisher: the lock pins {@code lockedArtifact}, the publisher ships {@code publishedArtifact}. */
    private Path project(String lockedArtifact, String publishedArtifact, boolean withLock) throws Exception {
        Path root = tmp.newFolder().toPath();
        byte[] locked = Files.readAllBytes(artifact(lockedArtifact));
        byte[] published = Files.readAllBytes(artifact(publishedArtifact));
        Path project = root.resolve("app");
        write(project.resolve("metaobjects/meta.app.json"), "{\"metadata.root\":{\"package\":\"app\",\"children\":[]}}");
        write(project.resolve(".metaobjects/config.json"),
                "{\"schema_version\":1,\"sources\":[],\"dependencies\":[{\"name\":\"acme-common\",\"path\":\"../acme-common/metaobjects\"}]}");
        if (withLock) {
            Path snapshot = project.resolve(".metaobjects/deps/acme-common/acme-common.metaobjects.json");
            Files.createDirectories(snapshot.getParent());
            Files.write(snapshot, locked);
            write(project.resolve(".metaobjects/deps.lock.json"),
                    "{\"schema_version\":1,\"dependencies\":{\"acme-common\":{\"version\":\"1.0.0\",\"metamodelVersion\":\"1.0\","
                            + "\"resolvedFrom\":{\"path\":\"../acme-common/metaobjects\"},\"artifact\":\"acme-common.metaobjects.json\","
                            + "\"integrity\":\"" + Dependencies.sha256Integrity(locked) + "\",\"packages\":[\"acme::common\"],"
                            + "\"nodes\":[\"acme::common::Address\",\"acme::common::Audited\",\"acme::common::Customer\"]}}}");
        }
        Path publisher = root.resolve("acme-common/metaobjects");
        Files.createDirectories(publisher);
        Files.write(publisher.resolve("acme-common.metaobjects.json"), published);
        write(publisher.resolve("metaobjects.pkg.json"),
                "{\"schema_version\":1,\"name\":\"acme-common\",\"version\":\"1.1.0\",\"metamodelVersion\":\"1.0\","
                        + "\"artifact\":\"acme-common.metaobjects.json\",\"integrity\":\"" + Dependencies.sha256Integrity(published)
                        + "\",\"packages\":[\"acme::common\"],"
                        + "\"nodes\":[\"acme::common::Address\",\"acme::common::Audited\",\"acme::common::Customer\"]}");
        return project;
    }

    private static MetaDataVerifyMojo mojo(Path project) {
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        verify.setLoader(LoaderParam.builder("verify-deps-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(project.resolve("metaobjects").toString())
                .build());
        verify.setGenerators(Collections.emptyList());
        verify.setGlobals(Collections.emptyMap());
        verify.setMode("deps");
        return verify;
    }

    @Test
    public void aMatchingPublisherPasses() throws Exception {
        mojo(project("acme-common-v1.json", "acme-common-v1.json", true)).execute();
    }

    @Test
    public void aPublisherThatMovedPastTheLockFailsAsDrifted() throws Exception {
        try {
            mojo(project("acme-common-v1.json", "acme-common-v1-widened.json", true)).execute();
            fail("expected the drifted dependency to fail the build");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("ERR_DEPENDENCY_UPSTREAM_DRIFT"));
            assertTrue(e.getMessage(), e.getMessage().contains("1 of 1 dependency"));
        }
    }

    @Test
    public void aDependencyNotYetInTheLockFailsAsUnresolved() throws Exception {
        try {
            mojo(project("acme-common-v1.json", "acme-common-v1.json", false)).execute();
            fail("a check that cannot check must not pass");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("ERR_DEPENDENCY_UPSTREAM_DRIFT"));
        }
    }

    @Test
    public void aProjectDeclaringNothingHasNothingToCheck() throws Exception {
        Path project = tmp.newFolder().toPath();
        Files.createDirectories(project.resolve("metaobjects"));
        write(project.resolve(".metaobjects/config.json"), "{\"schema_version\":1,\"sources\":[]}");
        mojo(project).execute();
    }

    @Test
    public void depsIsOptInAndNotPartOfTheDefaultGateSet() throws Exception {
        // A drifted dependency does not fail the default set: it needs the publisher reachable, which CI may not have.
        MetaDataVerifyMojo verify = mojo(project("acme-common-v1.json", "acme-common-v1-widened.json", true));
        verify.setMode("");
        verify.execute();
    }
}
