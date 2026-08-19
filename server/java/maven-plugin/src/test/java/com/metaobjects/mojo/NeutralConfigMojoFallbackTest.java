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

/**
 * Proves the port-neutral {@code .metaobjects/config.json} fallback (spec §5, ADR
 * cross-port metadata-source-resolution phase 1) is actually WIRED into
 * {@link AbstractMetaDataMojo#createLoader}, not merely defined and unit-tested in
 * isolation — the same gap that shipped in an earlier port's task before it was
 * caught in review. Every test here leaves the pom's {@code <loader>} silent on both
 * {@code sourceDir} and {@code sources}, so a regression that removes the
 * {@code resolveNeutralSourcesIfPomIsSilent(...)} call site (or short-circuits it)
 * makes {@code createLoader} load ZERO metadata objects instead of the one declared
 * under the neutral config's declared source — turning every assertion below false.
 */
public class NeutralConfigMojoFallbackTest {

    private static final String WIDGET_JSON = """
            {
              "metadata.root": {
                "package": "neutral::fallback",
                "children": [
                  { "object.entity": { "name": "Widget", "children": [
                    { "field.long": { "name": "id" } }
                  ] } }
                ]
              }
            }
            """;

    /** A pom-silent loader: no {@code <sourceDir>}, no {@code <sources>}. */
    private MetaDataGeneratorMojo mojoWithSilentPom(Path basedir) {
        MavenProject mavenProject = Mockito.mock(MavenProject.class);
        Mockito.when(mavenProject.getBasedir()).thenReturn(basedir.toFile());

        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        mojo.project = mavenProject;

        LoaderParam loader = LoaderParam.builder("neutral-fallback-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .build();
        mojo.setLoader(loader);
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        return mojo;
    }

    @Test
    public void createLoaderFallsBackToTheNeutralConfigsDeclaredSourceWhenPomIsSilent() throws IOException {
        Path root = Files.createTempDirectory("mo-mojo-neutral-").toAbsolutePath().normalize();
        try {
            Path metaDir = root.resolve("custom-metadata");
            Files.createDirectories(metaDir);
            Files.write(metaDir.resolve("meta.widget.json"), WIDGET_JSON.getBytes(StandardCharsets.UTF_8));

            Path dotMo = root.resolve(".metaobjects");
            Files.createDirectories(dotMo);
            Files.write(dotMo.resolve("config.json"),
                    "{\"schema_version\":1,\"sources\":[{\"path\":\"custom-metadata\"}]}"
                            .getBytes(StandardCharsets.UTF_8));

            MetaDataGeneratorMojo mojo = mojoWithSilentPom(root);
            MetaDataLoader loaded = mojo.createLoader(mojo.createProjectClassLoader());

            // If resolveNeutralSourcesIfPomIsSilent were never called (or its result
            // discarded), the loader would have been configured with zero sources and
            // loaded nothing — this assertion is exactly what removing the wiring
            // breaks.
            assertEquals("expected the ONE object declared under the neutral config's "
                            + "declared \"custom-metadata\" source — proves the fallback ran, "
                            + "not just the default directory",
                    1, loaded.getMetaObjects().size());
            assertEquals("Widget", loaded.getMetaObjects().get(0).getShortName());
        } finally {
            deleteRecursive(root);
        }
    }

    @Test
    public void createLoaderFallsBackToTheBuiltInDefaultDirectoryWhenNoNeutralConfigExists() throws IOException {
        Path root = Files.createTempDirectory("mo-mojo-neutral-default-").toAbsolutePath().normalize();
        try {
            // No .metaobjects/config.json at all — only the built-in default directory.
            Path defaultDir = root.resolve("metaobjects");
            Files.createDirectories(defaultDir);
            Files.write(defaultDir.resolve("meta.widget.json"), WIDGET_JSON.getBytes(StandardCharsets.UTF_8));

            MetaDataGeneratorMojo mojo = mojoWithSilentPom(root);
            MetaDataLoader loaded = mojo.createLoader(mojo.createProjectClassLoader());

            assertEquals(1, loaded.getMetaObjects().size());
            assertEquals("Widget", loaded.getMetaObjects().get(0).getShortName());
        } finally {
            deleteRecursive(root);
        }
    }

    @Test(expected = MetaDataException.class)
    public void createLoaderRaisesWhenPomIsSilentAndNoCollectionExists() throws IOException {
        // Neither a neutral config nor a default "metaobjects/" directory — the final
        // rung of the ladder must raise (ERR_COLLECTION_NOT_FOUND), not silently load
        // zero objects.
        Path root = Files.createTempDirectory("mo-mojo-neutral-empty-").toAbsolutePath().normalize();
        try {
            MetaDataGeneratorMojo mojo = mojoWithSilentPom(root);
            mojo.createLoader(mojo.createProjectClassLoader());
        } finally {
            deleteRecursive(root);
        }
    }

    private static void deleteRecursive(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.delete(p);
                } catch (IOException ignored) {
                    // best-effort temp-dir cleanup
                }
            });
        }
    }
}
