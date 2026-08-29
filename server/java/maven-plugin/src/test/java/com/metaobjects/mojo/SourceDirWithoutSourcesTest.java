package com.metaobjects.mojo;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.project.MavenProject;
import org.junit.Test;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.Comparator;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * A {@code <loader>} naming {@code <sourceDir>} and NOTHING else must load that
 * directory's metadata.
 *
 * <p>It used to load nothing at all — and say nothing about it. The precedence
 * ladder consults the port-neutral config only when the pom names NEITHER
 * {@code <sourceDir>} nor {@code <sources>}, so naming {@code <sourceDir>} alone
 * took the pom-owns-the-concern branch with an empty source list: the generators
 * ran against an empty model, wrote zero files, and the build reported SUCCESS.
 *
 * <p>Which matters because {@code <sourceDir>} alone is exactly what the shipped
 * adopter guidance teaches, and it is also the remedy 0.24.0's own
 * {@code ERR_COLLECTION_NOT_FOUND} prints ("declare {@code <sourceDir>}/{@code
 * <sources>} explicitly") — so following the fix for the silent-empty model put
 * you straight back into a silent-empty model.
 *
 * <p>Two neighbouring cases are pinned alongside it, because the fix makes this
 * branch tolerant and both are ways it could go quiet again: a {@code <sourceDir>}
 * that does not exist (already loud, an {@code IllegalArgumentException} naming the
 * path), and one that exists but holds no metadata at all.
 *
 * <p>Paths here are ABSOLUTE on purpose — {@code <sourceDir>} resolves against the
 * process working directory, not the module basedir, so a relative path in a test
 * would be measuring the runner's cwd rather than the mojo.
 */
public class SourceDirWithoutSourcesTest {

    private static final String WIDGET_JSON = """
            {
              "metadata.root": {
                "package": "sourcedir::only",
                "children": [
                  { "object.entity": { "name": "Widget", "children": [
                    { "field.long": { "name": "id" } }
                  ] } }
                ]
              }
            }
            """;

    /** A pom naming <sourceDir> and no <sources> — the documented shape. */
    private MetaDataGeneratorMojo mojoWithSourceDirOnly(Path basedir, String sourceDir) {
        MavenProject mavenProject = Mockito.mock(MavenProject.class);
        Mockito.when(mavenProject.getBasedir()).thenReturn(basedir.toFile());

        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        mojo.project = mavenProject;
        mojo.setLoader(LoaderParam.builder("sourcedir-only-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(sourceDir)
                .build());
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        return mojo;
    }

    @Test
    public void sourceDirAloneLoadsThatDirectorysMetadata() throws IOException {
        Path root = Files.createTempDirectory("mo-mojo-srcdir-").toAbsolutePath().normalize();
        try {
            Path metaDir = root.resolve("src/main/metaobjects");
            Files.createDirectories(metaDir);
            Files.write(metaDir.resolve("meta.widget.json"), WIDGET_JSON.getBytes(StandardCharsets.UTF_8));

            MetaDataGeneratorMojo mojo = mojoWithSourceDirOnly(root, metaDir.toString());
            MetaDataLoader loaded = mojo.createLoader(mojo.createProjectClassLoader());

            assertEquals("a <sourceDir> with no <sources> must load the directory, not nothing",
                    1, loaded.getMetaObjects().size());
            assertEquals("Widget", loaded.getMetaObjects().get(0).getShortName());
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    public void aSourceDirThatDoesNotExistFailsRatherThanLoadingNothing() throws IOException {
        Path root = Files.createTempDirectory("mo-mojo-srcdir-missing-").toAbsolutePath().normalize();
        Path typo = root.resolve("src/main/typo");
        try {
            MetaDataGeneratorMojo mojo = mojoWithSourceDirOnly(root, typo.toString());
            try {
                MetaDataLoader loaded = mojo.createLoader(mojo.createProjectClassLoader());
                fail("expected a failure naming the missing directory, got a loader with "
                        + loaded.getMetaObjects().size() + " object(s)");
            } catch (RuntimeException expected) {
                assertTrue("the message must name the path that did not resolve, got: "
                                + expected.getMessage(),
                        expected.getMessage().contains(typo.toString()));
            }
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    public void aSourceDirHoldingNoMetadataFailsRatherThanLoadingNothing() throws IOException {
        Path root = Files.createTempDirectory("mo-mojo-srcdir-empty-").toAbsolutePath().normalize();
        try {
            Path metaDir = root.resolve("src/main/metaobjects");
            Files.createDirectories(metaDir);

            MetaDataGeneratorMojo mojo = mojoWithSourceDirOnly(root, metaDir.toString());
            try {
                MetaDataLoader loaded = mojo.createLoader(mojo.createProjectClassLoader());
                fail("expected a failure naming the empty directory, got a loader with "
                        + loaded.getMetaObjects().size() + " object(s)");
            } catch (MetaDataException expected) {
                assertTrue("the message must name the directory that held nothing, got: "
                                + expected.getMessage(),
                        expected.getMessage().contains(metaDir.toString()));
            }
        } finally {
            deleteRecursive(root);
        }
    }

    private static void deleteRecursive(Path root) throws IOException {
        if (!Files.exists(root)) return;
        try (Stream<Path> walk = Files.walk(root)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        }
    }
}
