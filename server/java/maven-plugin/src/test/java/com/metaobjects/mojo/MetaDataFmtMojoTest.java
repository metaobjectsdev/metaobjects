package com.metaobjects.mojo;

import org.apache.maven.plugin.MojoFailureException;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * {@code mvn metaobjects:fmt} (#304) — mirrors the TS reference
 * ({@code fmt.test.ts} / {@code fmt-engine.ts}'s integration test) and the C#
 * port's {@code FmtCommandTests}: a messy file reformats, an already-canonical
 * file is untouched, an overlay file with no local base is skipped, and a
 * YAML file is always skipped.
 *
 * <p>The Mojo's {@code project}/{@code execution} fields are left null, same
 * allowance {@link MetaDataVerifyMojoTest} documents — {@code
 * createProjectClassLoader()} falls back to the test classloader.</p>
 */
public class MetaDataFmtMojoTest {

    private Path dir;

    private static final String MESSY_WIDGET =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [\n"
        + "  { \"object.entity\": { \"@description\": \"A widget\", \"name\": \"Widget\", \"children\": [\n"
        + "    { \"field.string\": { \"name\": \"sku\", \"@maxLength\": 40, \"@required\": true } }\n"
        + "  ]}}\n"
        + "]}}\n";

    private static final String CANONICAL_GADGET =
        "{\n  \"metadata.root\": {\n    \"package\": \"acme\",\n    \"children\": [\n"
        + "      {\n        \"object.entity\": {\n          \"name\": \"Gadget\",\n"
        + "          \"children\": [\n            {\n              \"field.string\": {\n"
        + "                \"name\": \"label\"\n              }\n            }\n          ]\n"
        + "        }\n      }\n    ]\n  }\n}\n";

    private static final String OVERLAY_WIDGET_UI =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [\n"
        + "  { \"object.entity\": { \"name\": \"Widget\", \"overlay\": true, \"children\": [\n"
        + "    { \"field.string\": { \"name\": \"notes\" } }\n"
        + "  ]}}\n"
        + "]}}\n";

    private static final String YAML_EXTRA = "metadata:\n  package: acme\n  children: []\n";

    @Before
    public void setUp() throws IOException {
        dir = Files.createTempDirectory("meta-fmt-mojo-test");
        Files.writeString(dir.resolve("meta.base.json"), MESSY_WIDGET, StandardCharsets.UTF_8);
        Files.writeString(dir.resolve("meta.already-canonical.json"), CANONICAL_GADGET, StandardCharsets.UTF_8);
        Files.writeString(dir.resolve("meta.widget.ui.json"), OVERLAY_WIDGET_UI, StandardCharsets.UTF_8);
        Files.writeString(dir.resolve("meta.extra.yaml"), YAML_EXTRA, StandardCharsets.UTF_8);
    }

    @After
    public void tearDown() throws IOException {
        try (var walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException ignored) { }
            });
        }
    }

    private MetaDataFmtMojo mojo() {
        MetaDataFmtMojo mojo = new MetaDataFmtMojo();
        LoaderParam loader = LoaderParam.builder("fmt-test")
            .withClassname("com.metaobjects.loader.MetaDataLoader")
            .withSourceDir(dir.toString())
            .build();
        mojo.setLoader(loader);
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        return mojo;
    }

    @Test
    public void reformatsMessyLeavesCanonicalSkipsOverlayAndYaml() throws Exception {
        String before = Files.readString(dir.resolve("meta.already-canonical.json"), StandardCharsets.UTF_8);

        mojo().execute();

        assertEquals(before, Files.readString(dir.resolve("meta.already-canonical.json"), StandardCharsets.UTF_8));
        assertNotEquals(MESSY_WIDGET, Files.readString(dir.resolve("meta.base.json"), StandardCharsets.UTF_8));
        assertEquals(OVERLAY_WIDGET_UI, Files.readString(dir.resolve("meta.widget.ui.json"), StandardCharsets.UTF_8));
        assertEquals(YAML_EXTRA, Files.readString(dir.resolve("meta.extra.yaml"), StandardCharsets.UTF_8));
    }

    @Test
    public void isIdempotent() throws Exception {
        mojo().execute();
        String once = Files.readString(dir.resolve("meta.base.json"), StandardCharsets.UTF_8);
        mojo().execute();
        assertEquals(once, Files.readString(dir.resolve("meta.base.json"), StandardCharsets.UTF_8));
    }

    @Test
    public void checkModeListsDriftAndChangesNothing() throws Exception {
        String before = Files.readString(dir.resolve("meta.base.json"), StandardCharsets.UTF_8);
        MetaDataFmtMojo mojo = mojo();
        mojo.check = true;
        try {
            mojo.execute();
            fail("expected MojoFailureException — the project has drift");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("not canonical"));
        }
        assertEquals(before, Files.readString(dir.resolve("meta.base.json"), StandardCharsets.UTF_8));
    }

    @Test
    public void checkModePassesOnceCanonical() throws Exception {
        mojo().execute();
        MetaDataFmtMojo check = mojo();
        check.check = true;
        check.execute(); // no exception — already canonical
    }

    @Test
    public void explicitFilesNarrowsTheRun() throws Exception {
        String beforeBase = Files.readString(dir.resolve("meta.base.json"), StandardCharsets.UTF_8);
        MetaDataFmtMojo mojo = mojo();
        mojo.files = dir.resolve("meta.already-canonical.json").toString();
        mojo.execute();
        // Untouched — only the named (already-canonical) file was in scope.
        assertEquals(beforeBase, Files.readString(dir.resolve("meta.base.json"), StandardCharsets.UTF_8));
    }

    @Test
    public void explicitFileOutsideResolvedSourcesFails() {
        MetaDataFmtMojo mojo = mojo();
        mojo.files = dir.resolve("does-not-exist.json").toString();
        try {
            mojo.execute();
            fail("expected MojoFailureException for a file outside the resolved sources");
        } catch (Exception e) {
            assertTrue(e instanceof MojoFailureException);
        }
    }

    @Test
    public void refusesWhenProjectDoesNotLoadCleanly() throws Exception {
        Files.writeString(dir.resolve("bad.json"), "{ this is not valid json", StandardCharsets.UTF_8);
        try {
            mojo().execute();
            fail("expected a failure — the project does not load cleanly");
        } catch (Exception e) {
            // MetaDataException (unchecked, from failOnLoaderErrors in createLoader) or
            // MojoFailureException are both acceptable "refused" outcomes.
        }
    }
}
