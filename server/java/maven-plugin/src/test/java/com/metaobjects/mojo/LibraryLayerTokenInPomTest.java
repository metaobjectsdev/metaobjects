package com.metaobjects.mojo;

import com.metaobjects.library.LibrarySources;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.MetaSource;
import org.apache.maven.project.MavenProject;
import org.junit.Test;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * A {@code <loader><libraries>} entry naming a LAYER — {@code iam/db}, not just
 * {@code iam} — must be accepted, and the layer must actually load.
 *
 * <p>It was rejected outright. The mojo validates the pom's tokens against
 * {@link LibrarySources#knownPackages()}, which returns the library NAMES
 * ({@code [ai, iam]}); the set a selection is actually drawn from is
 * {@link LibrarySources#knownTokens()} ({@code [ai, ai/db, iam, iam/db]}), whose
 * own javadoc says it is "what a config error prints". So a pom carrying the same
 * selection the TypeScript and Python configs carry failed the build with
 * "names unknown package(s) [iam/db, ai/db]; available: [ai, iam]".</p>
 *
 * <p>The resolver was never the problem — {@link LibrarySources#librarySources}
 * splits a token and looks the layer up, and has all along. Only the mojo's
 * pre-validation refused it, and {@code knownTokens()} had no caller anywhere in
 * the port. That is why the whole layer-token path could ship unnoticed: no JVM
 * test asserted a library DB layer loads at all.</p>
 *
 * <p>Why it matters beyond the error message: the core layer is deliberately INERT
 * (it declares no {@code source.rdb}), so a port that can only opt into {@code iam}
 * gets the design without the tables. Two ports generating from one model then
 * legitimately disagree, which is precisely the comparison the cross-port corpora
 * exist to make.</p>
 */
public class LibraryLayerTokenInPomTest {

    /** Any metadata at all — the loader needs a source; the libraries are the subject. */
    private static final String WIDGET_JSON = """
            {
              "metadata.root": {
                "package": "layertoken::only",
                "children": [
                  { "object.entity": { "name": "Widget", "children": [
                    { "field.long": { "name": "id" } }
                  ] } }
                ]
              }
            }
            """;

    private MetaDataGeneratorMojo mojoWithLibraries(Path basedir, String sourceDir,
                                                    List<String> libraries) {
        MavenProject mavenProject = Mockito.mock(MavenProject.class);
        Mockito.when(mavenProject.getBasedir()).thenReturn(basedir.toFile());

        LoaderParam loader = LoaderParam.builder("library-layer-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(sourceDir)
                .build();
        loader.setLibraries(libraries);

        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        mojo.project = mavenProject;
        mojo.setLoader(loader);
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        return mojo;
    }

    /**
     * The metadata-layer distinction, pinned so neither method is "simplified" into
     * the other. They answer different questions and both are wanted.
     */
    @Test
    public void knownTokensCarriesLayersAndKnownPackagesDoesNot() {
        List<String> tokens = LibrarySources.knownTokens();
        List<String> packages = LibrarySources.knownPackages();

        assertTrue("knownTokens must offer the db layer as a selectable token, got: " + tokens,
                tokens.contains("iam/db"));
        assertTrue("knownTokens must still offer the bare library, got: " + tokens,
                tokens.contains("iam"));
        assertFalse("knownPackages names LIBRARIES, not layers — if this starts passing, the "
                        + "two methods have collapsed and the mojo's validation is no longer "
                        + "the thing under test here, got: " + packages,
                packages.contains("iam/db"));
    }

    /** The regression: the pom's own spelling of the cross-port selection must load. */
    @Test
    public void aLayerTokenInThePomIsAccepted() throws IOException {
        Path root = Files.createTempDirectory("mo-mojo-libtoken-").toAbsolutePath().normalize();
        try {
            Path metaDir = root.resolve("src/main/metaobjects");
            Files.createDirectories(metaDir);
            Files.write(metaDir.resolve("meta.widget.json"), WIDGET_JSON.getBytes(StandardCharsets.UTF_8));

            MetaDataGeneratorMojo mojo = mojoWithLibraries(root, metaDir.toString(),
                    Arrays.asList("iam", "iam/db"));

            MetaDataLoader loaded = mojo.createLoader(mojo.createProjectClassLoader());

            MetaObject user = loaded.getMetaObjectByName("metaobjects::iam::User");
            assertEquals("the library's own object must load under its package",
                    "User", user.getShortName());

            // The point of the LAYER, not merely of the token parsing: the core layer is
            // sourceless by design, so a source child here proves db.yaml's overlay landed.
            // Resolving accessor deliberately (ADR-0039) — an own-only read would drop an
            // inherited source and read as "the layer did not load".
            List<MetaSource> sources = user.getChildren(MetaSource.class);
            assertFalse("iam/db must contribute a source.rdb to User; none present means the "
                            + "token was tolerated but the layer never loaded", sources.isEmpty());
        } finally {
            deleteRecursive(root);
        }
    }

    /**
     * The other half of the same rule: a token whose LAYER does not exist is still a hard
     * failure, and the message must offer the tokens rather than the library names — that
     * is the difference between "iam/database is not a thing" and a list you cannot act on.
     */
    @Test
    public void anUnknownLayerStillFailsAndNamesTheSelectableTokens() throws IOException {
        Path root = Files.createTempDirectory("mo-mojo-libtoken-bad-").toAbsolutePath().normalize();
        try {
            Path metaDir = root.resolve("src/main/metaobjects");
            Files.createDirectories(metaDir);
            Files.write(metaDir.resolve("meta.widget.json"), WIDGET_JSON.getBytes(StandardCharsets.UTF_8));

            MetaDataGeneratorMojo mojo = mojoWithLibraries(root, metaDir.toString(),
                    Collections.singletonList("iam/database"));
            try {
                mojo.createLoader(mojo.createProjectClassLoader());
                fail("expected a failure naming the mistyped layer");
            } catch (RuntimeException expected) {
                String msg = String.valueOf(expected.getMessage());
                assertTrue("the message must name the token that did not resolve, got: " + msg,
                        msg.contains("iam/database"));
                assertTrue("the message must offer the SELECTABLE tokens, not the library "
                                + "names — a user given [ai, iam] cannot tell what to type "
                                + "instead, got: " + msg,
                        msg.contains("iam/db"));
            }
        } finally {
            deleteRecursive(root);
        }
    }

    private static void deleteRecursive(Path root) throws IOException {
        if (!Files.exists(root)) return;
        try (Stream<Path> walk = Files.walk(root)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best-effort temp cleanup
                }
            });
        }
    }
}
