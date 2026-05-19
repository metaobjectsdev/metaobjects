package com.metaobjects.tools;

import com.metaobjects.attr.*;
import com.metaobjects.field.*;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.object.mapped.MappedMetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;

import static org.junit.Assert.*;

/**
 * Tests for LegacyMetadataConverter — the one-time tool that converts
 * legacy natural-JSON and XML metadata files to canonical JSON.
 *
 * <p>This converter (and this test) are deleted in H3b-1 Task 5 once all
 * fixture files have been converted.</p>
 */
public class LegacyMetadataConverterTest extends SharedRegistryTestBase {

    @Before
    public void setUp() {
        try {
            new StringField("testString");
            new IntegerField("testInt");
            new LongField("testLong");
            new DoubleField("testDouble");
            new BooleanField("testBoolean");
            new PrimaryIdentity("testPrimary");
            new StringAttribute("testStringAttr");
            new IntAttribute("testIntAttr");
            new BooleanAttribute("testBoolAttr");
            new DoubleAttribute("testDoubleAttr");
            new LongAttribute("testLongAttr");
            MappedMetaObject.create("setup::Boot");
        } catch (Exception e) {
            // Ignore registration errors — types may already be registered
        }
    }

    /**
     * Convert a natural-JSON file, then prove the canonical output loads to an
     * equivalent tree via CanonicalJsonParser.
     */
    @Test
    public void convertsNaturalJsonToEquivalentCanonical() throws Exception {
        // Natural-JSON format: bare type key with subType as a body field
        String naturalJson =
            "{ \"metadata\": { \"package\": \"test\", \"children\": [\n" +
            "  { \"field\": { \"name\": \"id\", \"subType\": \"long\" } },\n" +
            "  { \"identity\": { \"name\": \"primary\", \"subType\": \"primary\", \"@fields\": [\"id\"] } }\n" +
            "] } }";
        Path src = Files.createTempFile("legacy", ".json");
        try {
            Files.writeString(src, naturalJson);

            String canonical = LegacyMetadataConverter.convertToCanonical(src);

            // The canonical text must contain fused type.subType keys
            assertTrue("canonical should contain 'field.long'", canonical.contains("\"field.long\""));
            assertTrue("canonical should contain 'identity.primary'", canonical.contains("\"identity.primary\""));
            // Must end with a newline (canonical format spec)
            assertTrue("canonical should end with newline", canonical.endsWith("\n"));

            // Round-trip: the canonical output must load back via CanonicalJsonParser to
            // an equivalent tree — same field name and subType present.
            MetaDataLoader roundTripLoader = createTestLoader("LegacyConverter", Collections.emptyList());
            CanonicalJsonParser parser = new CanonicalJsonParser(roundTripLoader, "converted.json");
            parser.loadFromStream(new ByteArrayInputStream(canonical.getBytes(StandardCharsets.UTF_8)));

            // The loader root should have a 'field' child of subType 'long'
            assertNotNull("id field should exist in converted tree",
                roundTripLoader.getRoot().getChildOfType("field", "test::id"));
        } finally {
            Files.deleteIfExists(src);
        }
    }

    /**
     * Convert a natural-JSON file that uses an object.pojo — verify the canonical
     * output round-trips to a valid tree with that object present.
     */
    @Test
    public void convertsObjectWithChildrenToCanonical() throws Exception {
        String naturalJson =
            "{ \"metadata\": { \"package\": \"acme\", \"children\": [\n" +
            "  { \"object\": { \"name\": \"Product\", \"subType\": \"pojo\", \"children\": [\n" +
            "    { \"field\": { \"name\": \"sku\", \"subType\": \"string\" } }\n" +
            "  ] } }\n" +
            "] } }";
        Path src = Files.createTempFile("legacy_obj", ".json");
        try {
            Files.writeString(src, naturalJson);

            String canonical = LegacyMetadataConverter.convertToCanonical(src);

            // Canonical format should contain fused keys
            assertTrue("canonical should contain 'object.'", canonical.contains("\"object."));
            assertTrue("canonical should contain 'field.string'", canonical.contains("\"field.string\""));

            // Round-trip
            MetaDataLoader roundTripLoader = createTestLoader("LegacyConverterObj", Collections.emptyList());
            new CanonicalJsonParser(roundTripLoader, "converted.json")
                .loadFromStream(new ByteArrayInputStream(canonical.getBytes(StandardCharsets.UTF_8)));

            // Product object should exist under the package
            assertNotNull("Product should exist in converted tree",
                roundTripLoader.getRoot().getChildOfType("object", "acme::Product"));
        } finally {
            Files.deleteIfExists(src);
        }
    }

    /**
     * convertToCanonical on a non-existent file should throw an IOException.
     */
    @Test(expected = IOException.class)
    public void throwsOnNonExistentFile() throws Exception {
        LegacyMetadataConverter.convertToCanonical(Path.of("/no/such/file.json"));
    }
}
