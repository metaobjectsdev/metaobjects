/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR5c / ADR-0009 — multi-file merge attribution + {@code ERR_MERGE_CONFLICT}
 * + {@code WARN_DUPLICATE_DECLARATION} unit tests.
 *
 * <p>Mirrors {@code server/typescript/packages/metadata/test/fr5c-merge-attribution.test.ts}
 * — the same scenarios are exercised against the Java loader to validate the
 * cross-port port-conformance contract.</p>
 *
 * <p>Coverage:</p>
 * <ol>
 *   <li>Two files contributing distinct attrs → node source upgrades to
 *       {@link MergedSource} with both files in alphabetical order.</li>
 *   <li>Three files contributing distinct attrs → contributors[0].role is
 *       {@code overlay-base}; all subsequent positions are {@code overlay-extension}.</li>
 *   <li>Same {@code @attr} set to different values in two files →
 *       {@code ERR_MERGE_CONFLICT} recorded with both contributors.</li>
 *   <li>Same {@code @attr} set to the same value → no error (last-writer-wins
 *       on equal values is fine).</li>
 *   <li>Only one side declares the {@code @attr} → no error (overlay semantics
 *       by design).</li>
 *   <li>Two files declare an identical node → {@code WARN_DUPLICATE_DECLARATION}
 *       emitted on both the envelope-warning channel and the legacy string
 *       channel (so the existing conformance harness sees it).</li>
 *   <li>Real semantic overlay → no duplicate-declaration warning.</li>
 * </ol>
 */
public class Fr5cMergeAttributionTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("Fr5cMergeAttributionTest", Collections.emptyList());
    }

    // -----------------------------------------------------------------------
    // 1 — MergedSource upgrade
    // -----------------------------------------------------------------------

    @Test
    public void twoFilesContributeDistinctAttrsUpgradeToMergedSource() {
        String fileA = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true,"
            + "      \"@description\": \"A subscriber.\" } }"
            + "] } }";
        String fileB = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"@title\": \"Subscriber\" } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(fileA, "meta.a.json"),
            new InMemoryStringSource(fileB, "meta.b.json")));

        MetaData root = loader.getRoot();
        MetaData entity = root.getChildOfType("object", "acme::Subscriber");
        assertNotNull(entity);
        assertTrue("source should be MergedSource after multi-file overlay",
            entity.getSource() instanceof MergedSource);
        MergedSource ms = (MergedSource) entity.getSource();
        assertEquals(List.of("meta.a.json", "meta.b.json"), ms.files());
        assertEquals(2, ms.contributors().size());
        assertEquals("overlay-base", ms.contributors().get(0).role());
        assertEquals("meta.a.json", ms.contributors().get(0).file());
        assertEquals("overlay-extension", ms.contributors().get(1).role());
        assertEquals("meta.b.json", ms.contributors().get(1).file());
    }

    @Test
    public void threeFilesContributeListsAllContributorsAlphabetically() {
        String fileA = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true, "
            + "      \"@description\": \"A subscriber.\" } }"
            + "] } }";
        String fileB = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"@title\": \"Subscriber\" } }"
            + "] } }";
        String fileC = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"@notes\": \"Third file.\" } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(fileA, "meta.a.json"),
            new InMemoryStringSource(fileB, "meta.b.json"),
            new InMemoryStringSource(fileC, "meta.c.json")));

        MetaData entity = loader.getRoot().getChildOfType("object", "acme::Subscriber");
        assertTrue(entity.getSource() instanceof MergedSource);
        MergedSource ms = (MergedSource) entity.getSource();
        assertEquals(List.of("meta.a.json", "meta.b.json", "meta.c.json"), ms.files());
        assertEquals("overlay-base", ms.contributors().get(0).role());
        assertEquals("overlay-extension", ms.contributors().get(1).role());
        assertEquals("overlay-extension", ms.contributors().get(2).role());
    }

    // -----------------------------------------------------------------------
    // 2 — ERR_MERGE_CONFLICT
    // -----------------------------------------------------------------------

    @Test
    public void sameAttrDifferentNonEmptyValuesRecordsErrMergeConflict() {
        String fileA = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true, \"children\": ["
            + "    { \"field.string\": { \"name\": \"email\", \"@description\": \"Primary email.\" } }"
            + "  ] } }"
            + "] } }";
        String fileB = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"children\": ["
            + "    { \"field.string\": { \"name\": \"email\", \"@description\": \"Backup email.\" } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(fileA, "meta.a.json"),
            new InMemoryStringSource(fileB, "meta.b.json")));

        List<MetaDataException> errors = loader.getErrors();
        long mergeConflicts = errors.stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_MERGE_CONFLICT)
            .count();
        assertEquals("expected exactly one ERR_MERGE_CONFLICT", 1, mergeConflicts);

        MetaDataException conflict = errors.stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_MERGE_CONFLICT)
            .findFirst()
            .orElseThrow();
        ErrorSource env = conflict.getEnvelope().orElse(null);
        assertTrue("envelope must be MergedSource", env instanceof MergedSource);
        MergedSource ms = (MergedSource) env;
        assertEquals(List.of("meta.a.json", "meta.b.json"), ms.files());
        assertEquals(2, ms.contributors().size());
        assertEquals("overlay-base", ms.contributors().get(0).role());
        assertEquals("overlay-extension", ms.contributors().get(1).role());
        assertTrue("jsonPath should reference the conflicting attr",
            ms.jsonPath().contains("@description"));
    }

    @Test
    public void sameAttrSameValueProducesNoErrMergeConflict() {
        String fileA = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true, \"children\": ["
            + "    { \"field.string\": { \"name\": \"email\", \"@description\": \"Email.\" } }"
            + "  ] } }"
            + "] } }";
        String fileB = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"children\": ["
            + "    { \"field.string\": { \"name\": \"email\", \"@description\": \"Email.\" } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(fileA, "meta.a.json"),
            new InMemoryStringSource(fileB, "meta.b.json")));

        long mergeConflicts = loader.getErrors().stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_MERGE_CONFLICT)
            .count();
        assertEquals("equal values are not a conflict (last-writer-wins is fine)",
            0, mergeConflicts);
    }

    @Test
    public void sameArrayAttrIsNotFlaggedAsConflict() {
        // Regression: JSON arrays must be normalized to the same comma-delimited
        // form that {@code MetaAttribute.getValueAsString()} returns for stored
        // arrays. Without normalization, {@code ["id"]} would compare unequal
        // to a stored {@code "id"} and trigger a spurious ERR_MERGE_CONFLICT.
        String fileA = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"@fields\": [\"id\"] } }"
            + "  ] } }"
            + "] } }";
        String fileB = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"children\": ["
            + "    { \"identity.primary\": { \"@fields\": [\"id\"] } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(fileA, "meta.a.json"),
            new InMemoryStringSource(fileB, "meta.b.json")));

        long mergeConflicts = loader.getErrors().stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_MERGE_CONFLICT)
            .count();
        assertEquals("identical array attrs must not be flagged as conflicts",
            0, mergeConflicts);
    }

    @Test
    public void onlyOneSideDeclaresAttrProducesNoErrMergeConflict() {
        // File A sets @description; file B leaves it absent — that's overlay
        // semantics by design, not a conflict.
        String fileA = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true, \"children\": ["
            + "    { \"field.string\": { \"name\": \"email\", \"@description\": \"Email.\" } }"
            + "  ] } }"
            + "] } }";
        String fileB = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"children\": ["
            + "    { \"field.string\": { \"name\": \"email\" } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(fileA, "meta.a.json"),
            new InMemoryStringSource(fileB, "meta.b.json")));

        long mergeConflicts = loader.getErrors().stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_MERGE_CONFLICT)
            .count();
        assertEquals("absent vs. set is not a conflict", 0, mergeConflicts);
    }

    // -----------------------------------------------------------------------
    // 3 — WARN_DUPLICATE_DECLARATION
    // -----------------------------------------------------------------------

    @Test
    public void identicalRedeclarationFromDifferentFileEmitsWarnDuplicateDeclaration() {
        // Two files declare the same abstract entity identically. The merge
        // produces no semantic change (semanticDiff returns false), so we
        // expect WARN_DUPLICATE_DECLARATION on the envelope-warning channel —
        // and the message also surfaces in the legacy {@code getWarnings()}
        // string channel.
        String content = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true, \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.string\": { \"name\": \"email\" } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(content, "meta.a.json"),
            new InMemoryStringSource(content, "meta.b.json")));

        List<LoaderWarning> envelope = loader.getEnvelopeWarnings();
        long duplicates = envelope.stream()
            .filter(w -> "WARN_DUPLICATE_DECLARATION".equals(w.code()))
            .count();
        assertTrue("expected at least one WARN_DUPLICATE_DECLARATION; got " + envelope,
            duplicates >= 1);

        // One of the warnings should target the Subscriber entity.
        LoaderWarning subscriberWarn = envelope.stream()
            .filter(w -> "WARN_DUPLICATE_DECLARATION".equals(w.code())
                && w.message().contains("Subscriber"))
            .findFirst()
            .orElseThrow(() -> new AssertionError("no WARN_DUPLICATE_DECLARATION for Subscriber: "
                + envelope));
        assertTrue("warning source should be MergedSource",
            subscriberWarn.source() instanceof MergedSource);
        MergedSource ms = (MergedSource) subscriberWarn.source();
        assertEquals(List.of("meta.a.json", "meta.b.json"), ms.files());
        assertEquals("overlay-base", ms.contributors().get(0).role());
        assertEquals("overlay-extension", ms.contributors().get(1).role());

        // Mirror into legacy channel — the conformance harness reads warnings
        // as flat strings, so FR5c must also push the message into
        // getWarnings(). Verify the exact message text matches the cross-port
        // fixture format.
        assertTrue("legacy getWarnings() must surface the duplicate-declaration message; got "
                + loader.getWarnings(),
            loader.getWarnings().contains("duplicate declaration of Subscriber with no semantic change"));
    }

    @Test
    public void realSemanticOverlayDoesNotEmitWarnDuplicateDeclaration() {
        // File A: Subscriber with @description.
        // File B: Subscriber with @title (different attr — real overlay).
        String fileA = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true,"
            + "      \"@description\": \"A subscriber.\" } }"
            + "] } }";
        String fileB = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"@title\": \"Subscriber\" } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(fileA, "meta.a.json"),
            new InMemoryStringSource(fileB, "meta.b.json")));

        long duplicates = loader.getEnvelopeWarnings().stream()
            .filter(w -> "WARN_DUPLICATE_DECLARATION".equals(w.code()))
            .count();
        assertEquals("a semantic overlay must NOT produce WARN_DUPLICATE_DECLARATION",
            0, duplicates);
    }

    @Test
    public void thirdFileIdenticalDoesNotRevertMergedSource() {
        // Regression: when a third file declares the same node identically
        // (semantic_diff returns false), {@code tagNodeWithJsonSource} must
        // NOT reset the MergedSource that the FR5c attribution code already
        // built from the first two files. The third file should produce a
        // WARN_DUPLICATE_DECLARATION, and the saved MergedSource (with all
        // three files) must persist on the node.
        String fileA = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true,"
            + "      \"@description\": \"A subscriber.\" } }"
            + "] } }";
        String fileB = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"@title\": \"Subscriber\" } }"
            + "] } }";
        // File C re-declares identically to the post-A-and-B merged state — no
        // new attrs, so semantic_diff is false. This is the regression case.
        String fileC = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\" } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(
            new InMemoryStringSource(fileA, "meta.a.json"),
            new InMemoryStringSource(fileB, "meta.b.json"),
            new InMemoryStringSource(fileC, "meta.c.json")));

        MetaData entity = loader.getRoot().getChildOfType("object", "acme::Subscriber");
        assertTrue("after a third no-op contributor, source must remain MergedSource",
            entity.getSource() instanceof MergedSource);
        MergedSource ms = (MergedSource) entity.getSource();
        // The MergedSource files list MUST cover at least A and B (the two real
        // contributors). File C's emission path is via WARN_DUPLICATE_DECLARATION
        // which carries its own merged envelope (with C included); the node's
        // own source stays at the last upgrade point.
        assertTrue("files must include meta.a.json: " + ms.files(),
            ms.files().contains("meta.a.json"));
        assertTrue("files must include meta.b.json: " + ms.files(),
            ms.files().contains("meta.b.json"));
    }

    // -----------------------------------------------------------------------
    // 4 — Single-file path is unchanged (regression guard)
    // -----------------------------------------------------------------------

    @Test
    public void singleFileLoadKeepsJsonSourceUnchanged() {
        // FR5c must NOT upgrade a single-file node's source to MergedSource.
        String content = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Subscriber\", \"abstract\": true } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(content, "meta.a.json")));

        MetaData entity = loader.getRoot().getChildOfType("object", "acme::Subscriber");
        assertNotNull(entity);
        assertTrue("single-file load must produce a JsonSource, not a MergedSource",
            entity.getSource() instanceof JsonSource);
        assertEquals(0, loader.getEnvelopeWarnings().size());
        long mergeConflicts = loader.getErrors().stream()
            .filter(e -> e.getCode().orElse(null) == ErrorCode.ERR_MERGE_CONFLICT)
            .count();
        assertEquals(0, mergeConflicts);
    }
}
