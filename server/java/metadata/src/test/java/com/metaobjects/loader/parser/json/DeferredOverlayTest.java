package com.metaobjects.loader.parser.json;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.yaml.ParserYaml;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.source.ErrorSource;
import com.metaobjects.source.ResolvedSource;
import com.metaobjects.source.YamlSource;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.*;

/**
 * ADR-0055 — overlay application is a deferred pass.
 *
 * <p>The cross-port behaviour — order independence, the G1/G2 ordering, the
 * {@code format: "resolved"} error envelope — is gated by the shared corpus
 * ({@code fixtures/conformance/overlay-*}). These tests cover the things a
 * fixture directory CANNOT reach, because every fixture enters through
 * {@link MetaDataLoader#load(java.util.List)}:</p>
 *
 * <ol>
 *   <li><b>The standalone door.</b> A parser driven directly — no loader batch —
 *       must drain its own queue at the end of its document, or an embedder that
 *       calls {@code loadFromStream} itself silently loses every overlay. The
 *       loader sets {@code deferringOverlays} for the batch; nothing else does.</li>
 *   <li><b>The parser outlives its parse.</b> A queued element is applied after
 *       {@code buildTree} has returned and run its {@code finally}, which CLEARS
 *       the FR5b position map. The element therefore carries its own copy — and a
 *       node the overlay contributes still gets a {@link YamlSource}, not a
 *       json-flavoured envelope. No fixture asserts this: the YAML overlay fixture
 *       is a happy path and envelope format only surfaces on a diagnostic.</li>
 * </ol>
 */
public class DeferredOverlayTest extends SharedRegistryTestBase {

    /** A document whose overlay of {@code Widget} PRECEDES the plain declaration. */
    private static final String OVERLAY_BEFORE_BASE =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Widget\", \"overlay\": true, \"children\": ["
        + "    { \"field.string\": { \"name\": \"extra\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Widget\", \"children\": ["
        + "    { \"field.string\": { \"name\": \"id\" } } ] } }"
        + "] } }";

    /** A MIXED document: one plain declaration plus an overlay of an absent node. */
    private static final String MIXED_NO_TARGET =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
        + "  { \"object.entity\": { \"name\": \"Gadget\", \"children\": ["
        + "    { \"field.string\": { \"name\": \"gid\" } } ] } },"
        + "  { \"object.entity\": { \"name\": \"Widget\", \"overlay\": true, \"children\": ["
        + "    { \"field.string\": { \"name\": \"extra\" } } ] } }"
        + "] } }";

    /** Sigil-free YAML: the overlay again precedes the base it re-opens. */
    private static final String YAML_OVERLAY_BEFORE_BASE =
        "metadata.root:\n"
        + "  package: acme\n"
        + "  children:\n"
        + "    - object.entity:\n"
        + "        name: Widget\n"
        + "        overlay: true\n"
        + "        children:\n"
        + "          - field.string:\n"
        + "              name: extra\n"
        + "    - object.entity:\n"
        + "        name: Widget\n"
        + "        children:\n"
        + "          - field.string:\n"
        + "              name: id\n";

    private MetaDataLoader newTestLoader(String testName) {
        return createTestLoader(testName, Collections.emptyList());
    }

    private static ByteArrayInputStream stream(String content) {
        return new ByteArrayInputStream(content.getBytes(StandardCharsets.UTF_8));
    }

    private static List<String> fieldNames(MetaData object) {
        // ADR-0039 sanctioned own read: this asserts what the OVERLAY contributed
        // to the declaration layer, not the effective (inherited) view.
        return object.getChildren(MetaField.class, false).stream()
            .map(MetaData::getShortName)
            .collect(Collectors.toList());
    }

    // -----------------------------------------------------------------------
    // 1 — the standalone door
    // -----------------------------------------------------------------------

    @Test
    public void standaloneParserDrainsItsOwnQueue() {
        MetaDataLoader loader = newTestLoader("StandaloneDrain");
        new CanonicalJsonParser(loader, "meta.widget.json")
            .loadFromStream(stream(OVERLAY_BEFORE_BASE));

        assertTrue("no errors expected: " + loader.getErrors(), loader.getErrors().isEmpty());
        MetaData widget = loader.getRoot().getChildOfType("object", "acme::Widget");
        // G1 — the plain declaration lands first even though it was authored second.
        assertEquals(List.of("id", "extra"), fieldNames(widget));
    }

    @Test
    public void standaloneParserRecordsAMissingTargetAndKeepsTheSiblings() {
        MetaDataLoader loader = newTestLoader("StandaloneNoTarget");
        new CanonicalJsonParser(loader, "meta.commerce.json")
            .loadFromStream(stream(MIXED_NO_TARGET));

        assertEquals(1, loader.getErrors().size());
        MetaDataException err = loader.getErrors().get(0);
        assertEquals(ErrorCode.ERR_OVERLAY_NO_TARGET, err.getCode().orElse(null));

        // ADR-0009 FR5d — a reference that did not resolve, reported at the
        // declaration's own location (the JSONPath survived the walk unwinding).
        ErrorSource envelope = err.getEnvelope().orElse(null);
        assertTrue("expected a resolved envelope, got " + envelope,
            envelope instanceof ResolvedSource);
        ResolvedSource resolved = (ResolvedSource) envelope;
        assertEquals("resolved", resolved.format());
        assertEquals(List.of("meta.commerce.json"), resolved.files());
        assertEquals("$['metadata.root'].children[1]['object.entity']", resolved.jsonPath());
        assertEquals("acme::Widget", resolved.referrer());
        assertEquals("object:Widget", resolved.target());

        // The eager throw abandoned the whole document; the deferred pass does not.
        assertNotNull(loader.getRoot().getChildOfType("object", "acme::Gadget"));
    }

    // -----------------------------------------------------------------------
    // 2 — the parser outlives its parse
    // -----------------------------------------------------------------------

    @Test
    public void aYamlOverlaysContributionKeepsItsYamlProvenance() {
        MetaDataLoader loader = newTestLoader("YamlDeferredProvenance");
        new ParserYaml(loader, "meta.widget.yaml")
            .loadFromStream(stream(YAML_OVERLAY_BEFORE_BASE));

        assertTrue("no errors expected: " + loader.getErrors(), loader.getErrors().isEmpty());
        MetaData widget = loader.getRoot().getChildOfType("object", "acme::Widget");
        assertEquals(List.of("id", "extra"), fieldNames(widget));

        // `buildTree` clears yamlPositionsByPath in its finally, so the field the
        // DEFERRED overlay contributed can only be yaml-flavoured if the queued
        // element carried the position map out with it.
        MetaData extra = widget.getChildOfType("field", "extra", false);
        assertTrue("expected a YamlSource for the deferred contribution, got "
            + extra.getSource(), extra.getSource() instanceof YamlSource);
    }
}
