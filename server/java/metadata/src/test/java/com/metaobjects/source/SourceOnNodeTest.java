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
import com.metaobjects.MetaRoot;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR5a / ADR-0009 — {@code MetaData.source} provenance unit tests.
 *
 * <p>Covers the cases mandated by the FR §"Per-port unit tests":</p>
 * <ol>
 *   <li>Constructor stores source (default {@link CodeSource} for programmatic
 *       construction).</li>
 *   <li>{@code setSource()} overwrites; {@code freezeSource()} blocks further mutation.</li>
 *   <li>Parser populates {@link JsonSource} on every node during the tree walk.</li>
 *   <li>Canonical-JSON serializer OMITS {@code source} from its output.</li>
 *   <li>Parse errors carry the envelope via
 *       {@link MetaDataException#getEnvelope()}.</li>
 * </ol>
 *
 * <p>Mirrors {@code SourceOnNodeTests} in
 * {@code server/csharp/MetaObjects.Conformance.Tests/SourceOnNodeTests.cs}.</p>
 */
public class SourceOnNodeTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // 1 + 2 — programmatic construction + freeze guard
    // -----------------------------------------------------------------------

    @Test
    public void programmaticConstructionDefaultsToCodeSource() {
        MetaData node = new MetaData(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE, "test::Node");
        assertNotNull("source must never be null", node.getSource());
        assertTrue("default source must be a CodeSource", node.getSource() instanceof CodeSource);
        assertEquals("code", node.getSource().format());
        assertSame("default singleton is CodeSource.DEFAULT", CodeSource.DEFAULT, node.getSource());
    }

    @Test
    public void setSourceReplacesProvenance() {
        MetaData node = new MetaData(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE, "test::Node");
        node.setSource(new JsonSource(List.of("fixtures/foo.json"), "$"));
        assertTrue(node.getSource() instanceof JsonSource);
        JsonSource js = (JsonSource) node.getSource();
        assertEquals("fixtures/foo.json", js.files().get(0));
        assertEquals("$", js.jsonPath());
    }

    @Test
    public void freezeSourceBlocksFurtherMutation() {
        MetaData node = new MetaData(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE, "test::Node");
        node.setSource(new JsonSource(List.of("fixtures/foo.json"), "$"));
        node.freezeSource();
        assertTrue(node.isSourceFrozen());
        try {
            node.setSource(new CodeSource("after-freeze"));
            fail("expected IllegalStateException after freezeSource()");
        } catch (IllegalStateException expected) {
            // ok
        }
    }

    @Test(expected = NullPointerException.class)
    public void setSourceRejectsNull() {
        MetaData node = new MetaData(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE, "test::Node");
        node.setSource(null);
    }

    @Test
    public void jsonSourceLengthOneInvariantEnforced() {
        try {
            new JsonSource(List.of(), "$");
            fail("expected IllegalArgumentException for zero-length files");
        } catch (IllegalArgumentException expected) {
            // ok — FR5a invariant
        }
        try {
            new JsonSource(List.of("a", "b"), "$");
            fail("expected IllegalArgumentException for two-length files");
        } catch (IllegalArgumentException expected) {
            // ok — multi-file lives on MergedSource
        }
    }

    // -----------------------------------------------------------------------
    // 3 — parser populates JsonSource on every node
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("SourceOnNodeTest", Collections.emptyList());
    }

    @Test
    public void parserPopulatesJsonSourceOnEveryNode() {
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"demo\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Widget\","
            + "    \"children\": ["
            + "      { \"field.string\": { \"name\": \"id\" } },"
            + "      { \"identity.primary\": { \"@fields\": [\"id\"] } }"
            + "    ]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, "demo.json")));

        // Root carries a JsonSource — wrapper key `metadata.root` has a literal `.`,
        // so canonical form uses bracket-quoted notation per ADR-0009 §"Path format".
        MetaData root = loader.getRoot();
        assertTrue("root.source must be JsonSource",
            root.getSource() instanceof JsonSource);
        JsonSource rootJs = (JsonSource) root.getSource();
        assertEquals(List.of("demo.json"), rootJs.files());
        assertEquals("$['metadata.root']", rootJs.jsonPath());

        // The entity carries a JsonSource pointing at the children[0] wrapper.
        MetaData entity = root.getChildOfType("object", "demo::Widget");
        assertNotNull(entity);
        assertTrue("entity.source must be JsonSource",
            entity.getSource() instanceof JsonSource);
        JsonSource entityJs = (JsonSource) entity.getSource();
        assertEquals(
            "$['metadata.root'].children[0]['object.entity']",
            entityJs.jsonPath());

        // The id field carries a JsonSource pointing at its position under the entity.
        MetaData idField = entity.getChildOfType("field", "id");
        assertNotNull(idField);
        assertTrue("id field source must be JsonSource",
            idField.getSource() instanceof JsonSource);
        JsonSource idJs = (JsonSource) idField.getSource();
        assertEquals(
            "$['metadata.root'].children[0]['object.entity'].children[0]['field.string']",
            idJs.jsonPath());
    }

    // -----------------------------------------------------------------------
    // 4 — canonical-JSON serializer omits source
    // -----------------------------------------------------------------------

    @Test
    public void canonicalSerializerOmitsSourceFromOutput() {
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"demo\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Widget\","
            + "    \"children\": ["
            + "      { \"field.string\": { \"name\": \"id\" } },"
            + "      { \"identity.primary\": { \"@fields\": [\"id\"] } }"
            + "    ]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, "demo.json")));

        // Sanity — root has a JsonSource populated (parsing populated it).
        MetaData root = loader.getRoot();
        assertTrue(root.getSource() instanceof JsonSource);

        // Canonical-JSON output must not contain a "source" key (loader-derived state).
        String out = CanonicalJsonSerializer.canonicalSerialize(root);
        assertFalse("canonical JSON must not include a 'source' key: " + out,
            out.contains("\"source\""));
        assertFalse("canonical JSON must not include a 'jsonPath' key: " + out,
            out.contains("\"jsonPath\""));
        // (the discriminant tag "format" can legitimately appear in other contexts
        // — we narrow our assertion to the source-specific keys.)
    }

    // -----------------------------------------------------------------------
    // 5 — parse-error envelope carries JsonSource
    // -----------------------------------------------------------------------

    @Test
    public void parseErrorEnvelopeCarriesJsonSource() {
        // Trigger ERR_RESERVED_ATTR: write the reserved `isArray` structural keyword
        // as an @-prefixed attribute, which is unconditionally invalid per ADR-0006.
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"demo\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Broken\","
            + "    \"@isArray\": true"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "broken.json")));
            fail("expected MetaDataException for @-prefixed reserved key");
        } catch (MetaDataException ex) {
            // The envelope must be populated for parse-time errors per FR5a.
            assertTrue("expected ERR_RESERVED_ATTR, got: " + ex.getCode(),
                ex.getCode().map(c -> c == ErrorCode.ERR_RESERVED_ATTR).orElse(false));
            assertTrue("expected populated envelope on parse error",
                ex.getEnvelope().isPresent());
            ErrorSource envelope = ex.getEnvelope().get();
            assertTrue("envelope must be a JsonSource",
                envelope instanceof JsonSource);
            JsonSource js = (JsonSource) envelope;
            assertEquals(List.of("broken.json"), js.files());
            // JSONPath points at the offending node wrapper key
            assertTrue(
                "expected JSONPath to include the offending wrapper key: " + js.jsonPath(),
                js.jsonPath().contains("['object.entity']"));
        }
    }

    // -----------------------------------------------------------------------
    // 6 — MetaRoot also defaults to CodeSource pre-parse
    // -----------------------------------------------------------------------

    @Test
    public void freshMetaRootDefaultsToCodeSource() {
        MetaRoot root = new MetaRoot("test");
        assertTrue("fresh MetaRoot defaults to CodeSource",
            root.getSource() instanceof CodeSource);
    }
}
