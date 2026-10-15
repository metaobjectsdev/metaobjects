package com.metaobjects.mojo;

import com.metaobjects.database.ColumnNaming;
import com.metaobjects.database.PhysicalNaming;
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
 * ADR-0058 — a per-port pom in a subdirectory of a polyglot project
 * ({@code <repo>/jvm/pom.xml} with {@code <sourceDir>../metaobjects</sourceDir>}) must read
 * {@code naming} from the project that holds the metadata ({@code <repo>/.metaobjects/config.json}),
 * not silently fall back to the default because the module basedir has no config. The
 * TypeScript {@code meta migrate} reads that same root config, so a fallback here emits
 * {@code created_at} against a database whose column is {@code createdAt}.
 */
public class NamingConfigLocationTest {

    private static final String WIDGET_JSON = """
            {
              "metadata.root": {
                "package": "naming::location",
                "children": [
                  { "object.entity": { "name": "Widget", "children": [
                    { "field.long": { "name": "id" } }
                  ] } }
                ]
              }
            }
            """;

    private static final String LITERAL_CONFIG =
            "{\"schema_version\":1,\"naming\":{\"columns\":\"literal\",\"tables\":\"literal\"}}";

    private MetaDataGeneratorMojo mojo(Path basedir, String sourceDir) {
        MavenProject mavenProject = Mockito.mock(MavenProject.class);
        Mockito.when(mavenProject.getBasedir()).thenReturn(basedir.toFile());

        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        mojo.project = mavenProject;
        mojo.setLoader(LoaderParam.builder("naming-location-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(sourceDir)
                .build());
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        return mojo;
    }

    /** {@code <repo>/metaobjects/meta.widget.json} plus an empty {@code <repo>/jvm} module. */
    private static Path polyglotRepo(Path repo) throws IOException {
        Files.createDirectories(repo.resolve(".git"));
        Path metaDir = repo.resolve("metaobjects");
        Files.createDirectories(metaDir);
        Files.write(metaDir.resolve("meta.widget.json"), WIDGET_JSON.getBytes(StandardCharsets.UTF_8));
        Path module = repo.resolve("jvm");
        Files.createDirectories(module);
        return module;
    }

    private static void writeConfig(Path dir, String json) throws IOException {
        Files.createDirectories(dir.resolve(".metaobjects"));
        Files.write(dir.resolve(".metaobjects/config.json"), json.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void aSubdirectoryPomReadsNamingFromTheProjectHoldingItsSourceDir() throws IOException {
        Path repo = Files.createTempDirectory("mo-mojo-naming-").toAbsolutePath().normalize();
        try {
            Path module = polyglotRepo(repo);
            writeConfig(repo, LITERAL_CONFIG);

            MetaDataGeneratorMojo mojo = mojo(module, "../metaobjects");
            MetaDataLoader loaded = mojo.createLoader(mojo.createProjectClassLoader());

            PhysicalNaming naming = loaded.getRoot().getPhysicalNaming();
            assertEquals(ColumnNaming.LITERAL, naming.columns());
            assertEquals(PhysicalNaming.TABLE_LITERAL, naming.tables());
        } finally {
            deleteRecursive(repo);
        }
    }

    @Test
    public void theSearchStopsAtTheRepositoryRoot() throws IOException {
        Path outer = Files.createTempDirectory("mo-mojo-naming-outer-").toAbsolutePath().normalize();
        try {
            writeConfig(outer, LITERAL_CONFIG);
            Path module = polyglotRepo(outer.resolve("repo"));

            MetaDataGeneratorMojo mojo = mojo(module, "../metaobjects");
            MetaDataLoader loaded = mojo.createLoader(mojo.createProjectClassLoader());

            assertEquals("a config outside the repository is not this project's",
                    PhysicalNaming.DEFAULT_COLUMNS, loaded.getRoot().getPhysicalNaming().columns());
        } finally {
            deleteRecursive(outer);
        }
    }

    private static void deleteRecursive(Path root) throws IOException {
        if (!Files.exists(root)) return;
        try (Stream<Path> walk = Files.walk(root)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        }
    }
}
