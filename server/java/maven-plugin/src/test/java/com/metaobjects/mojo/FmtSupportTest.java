package com.metaobjects.mojo;

import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * {@code FmtSupport.run} (#304 review follow-up) — the safety check must
 * never write a byte to disk before it is proven safe, and {@code --check}
 * must never write at all. Direct tests against the pure-logic class (no
 * Mojo, no Maven session), exercising the in-memory-source mechanism
 * {@link FmtSupport#run} uses in place of the write-then-revert one it had
 * before this fix.
 */
public class FmtSupportTest {

    private Path dir;

    private static final String MESSY_WIDGET =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [\n"
        + "  { \"object.entity\": { \"@description\": \"A widget\", \"name\": \"Widget\", \"children\": [\n"
        + "    { \"field.string\": { \"name\": \"sku\", \"@maxLength\": 40, \"@required\": true } }\n"
        + "  ]}}\n"
        + "]}}\n";

    @Before
    public void setUp() throws IOException {
        dir = Files.createTempDirectory("fmt-support-test");
        Files.writeString(dir.resolve("meta.base.json"), MESSY_WIDGET, StandardCharsets.UTF_8);
    }

    @After
    public void tearDown() throws IOException {
        try (var walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException ignored) { }
            });
        }
    }

    private MetaDataLoader freshLoader(boolean strict) {
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, strict), MetaDataLoader.SUBTYPE_MANUAL, "acme");
        loader.init();
        return loader;
    }

    private MetaDataLoader loadBaseline(Path path, boolean strict) {
        MetaDataLoader baseline = freshLoader(strict);
        baseline.load(List.of(new com.metaobjects.loader.FileSource(path)));
        return baseline;
    }

    @Test
    public void checkModeNeverWritesAByte() throws IOException {
        Path base = dir.resolve("meta.base.json");
        byte[] before = Files.readAllBytes(base);
        MetaDataLoader baseline = loadBaseline(base, false);

        FmtSupport.RunResult result = FmtSupport.run(
            baseline,
            List.of(base),
            List.of(base),
            List.of(),
            () -> freshLoader(false),
            loaderName -> freshLoader(false),
            /* check = */ true);

        assertEquals(1, result.files.size());
        assertEquals(FmtSupport.Status.WOULD_FORMAT, result.files.get(0).status);
        assertTrue("checkMode must not write any byte to disk",
            java.util.Arrays.equals(before, Files.readAllBytes(base)));
    }

    @Test
    public void anUnsafeCandidateIsNeverWritten() throws IOException {
        Path base = dir.resolve("meta.base.json");
        byte[] before = Files.readAllBytes(base);
        // Baseline loads LAX (strict=false) — the messy file carries no unknown
        // attrs, so this is clean either way. Force the SAFETY-CHECK reload loader
        // to disagree about something the baseline never saw, by handing it a
        // DIFFERENT loader name than the baseline used — the canonical output's
        // (leaked) top-level "package" then differs from the baseline's, so the
        // byte-identical check fails even though the candidate is a legitimate
        // reformat. This manufactures the "unsafe" branch deterministically,
        // without depending on finding a real formatter bug to trigger it.
        MetaDataLoader baseline = loadBaseline(base, false);

        FmtSupport.RunResult result = FmtSupport.run(
            baseline,
            List.of(base),
            List.of(base),
            List.of(),
            () -> {
                MetaDataLoader l = new MetaDataLoader(
                    LoaderOptions.create(false, false, false), MetaDataLoader.SUBTYPE_MANUAL, "not-acme");
                l.init();
                return l;
            },
            loaderName -> freshLoader(false),
            /* check = */ false);

        assertEquals(1, result.files.size());
        assertEquals(FmtSupport.Status.ERROR, result.files.get(0).status);
        assertTrue("an unsafe candidate must never be written to disk",
            java.util.Arrays.equals(before, Files.readAllBytes(base)));
    }

    @Test
    public void formatFileReportsOverlayEvenWhenALocalBaseExistsNeverMerges() {
        // A plain Widget AND a same-(type,name) overlay:true redeclaration, both
        // in this one file. CanonicalJsonParser's ordinary find-or-reuse WOULD
        // merge these (the base exists locally), dropping the overlay marker.
        // fmt must never do that — a formatter never changes structure.
        String doc =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [\n"
            + "  { \"object.entity\": { \"name\": \"Widget\", \"children\": [\n"
            + "    { \"field.string\": { \"name\": \"sku\" } }\n"
            + "  ]}},\n"
            + "  { \"object.entity\": { \"name\": \"Widget\", \"overlay\": true, \"children\": [\n"
            + "    { \"field.string\": { \"name\": \"notes\" } }\n"
            + "  ]}}\n"
            + "]}}\n";
        FmtSupport.FormatFileResult result = FmtSupport.formatFile(
            loaderName -> freshLoader(false), doc, "meta.widget.json");
        assertTrue(!result.ok);
        assertTrue(result.overlay);
    }

    @Test
    public void formatFileStripsBomAndNormalizesCrlf() {
        String body =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [\n"
            + "  { \"object.entity\": { \"name\": \"Gadget\", \"children\": [] } }\n"
            + "]}}\n";
        String withBom = "﻿" + body.replace("\n", "\r\n");
        FmtSupport.FormatFileResult result = FmtSupport.formatFile(
            loaderName -> freshLoader(false), withBom, "meta.gadget.json");
        assertTrue(result.ok);
        assertTrue(result.text.charAt(0) != '﻿');
        assertTrue(!result.text.contains("\r\n"));
    }

    @Test
    public void aSafeCandidateIsWrittenExactlyOnceAfterVerification() throws IOException {
        Path base = dir.resolve("meta.base.json");
        MetaDataLoader baseline = loadBaseline(base, false);

        FmtSupport.RunResult result = FmtSupport.run(
            baseline,
            List.of(base),
            List.of(base),
            List.of(),
            () -> freshLoader(false),
            loaderName -> freshLoader(false),
            /* check = */ false);

        assertEquals(1, result.files.size());
        assertEquals(FmtSupport.Status.FORMATTED, result.files.get(0).status);
        String after = Files.readString(base, StandardCharsets.UTF_8);
        assertTrue("expected the reformatted content to differ from the messy original",
            !after.equals(MESSY_WIDGET));
    }
}
