package com.metaobjects.tools;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
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
     *
     * <p>Strengthened (H3b-1 Task 3): also asserts root package fidelity, correct
     * child FQNs, and absence of redundant package keys on children.</p>
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

            // ---- Structural checks ----
            // The canonical text must contain fused type.subType keys
            assertTrue("canonical should contain 'field.long'", canonical.contains("\"field.long\""));
            assertTrue("canonical should contain 'identity.primary'", canonical.contains("\"identity.primary\""));
            // Must end with a newline (canonical format spec)
            assertTrue("canonical should end with newline", canonical.endsWith("\n"));

            // ---- Package-fidelity check ----
            // Parse the canonical JSON and verify the root package equals the source's
            // declared package ("test"), NOT the loader name ("legacy_converter").
            JsonObject canonicalRoot = JsonParser.parseString(canonical).getAsJsonObject();
            JsonObject rootBody = getMetadataRootBody(canonicalRoot);
            assertNotNull("canonical output must have a metadata.root body", rootBody);
            assertTrue("root body must carry a 'package' key", rootBody.has("package"));
            assertEquals("root package must equal the source's declared package",
                "test", rootBody.get("package").getAsString());

            // ---- No-redundant-package-on-children check ----
            // Children in the same package as the root must NOT carry a redundant
            // "package" key (the serializer suppresses equal-to-parent package).
            assertNoRedundantPackageOnChildren(rootBody, "test");

            // ---- Round-trip check ----
            // The canonical output must load back via CanonicalJsonParser to an equivalent
            // tree with the same FQ names.
            MetaDataLoader roundTripLoader = createTestLoader("LegacyConverterRT", Collections.emptyList());
            CanonicalJsonParser parser = new CanonicalJsonParser(roundTripLoader, "converted.json");
            parser.loadFromStream(new ByteArrayInputStream(canonical.getBytes(StandardCharsets.UTF_8)));

            // The loader root should have a 'field' child with the FQ name "test::id"
            assertNotNull("id field should exist at test::id in converted tree",
                roundTripLoader.getRoot().getChildOfType("field", "test::id"));
        } finally {
            Files.deleteIfExists(src);
        }
    }

    /**
     * Proves that when the source file declares {@code "package": "acme::commerce"},
     * the root {@code package} in the canonical output is {@code "acme::commerce"} —
     * not the loader-sentinel.
     */
    @Test
    public void rootPackageMatchesDeclaredPackage_multiSegment() throws Exception {
        String naturalJson =
            "{ \"metadata\": { \"package\": \"acme::commerce\", \"children\": [\n" +
            "  { \"field\": { \"name\": \"price\", \"subType\": \"long\" } }\n" +
            "] } }";
        Path src = Files.createTempFile("legacy_pkg", ".json");
        try {
            Files.writeString(src, naturalJson);

            String canonical = LegacyMetadataConverter.convertToCanonical(src);

            JsonObject canonicalRoot = JsonParser.parseString(canonical).getAsJsonObject();
            JsonObject rootBody = getMetadataRootBody(canonicalRoot);
            assertNotNull("canonical output must have a metadata.root body", rootBody);
            assertTrue("root body must carry a 'package' key", rootBody.has("package"));
            assertEquals("root package must equal the source's declared multi-segment package",
                "acme::commerce", rootBody.get("package").getAsString());

            // Round-trip: price should be at "acme::commerce::price"
            MetaDataLoader rtLoader = createTestLoader("LegacyConverterPkg", Collections.emptyList());
            new CanonicalJsonParser(rtLoader, "converted.json")
                .loadFromStream(new ByteArrayInputStream(canonical.getBytes(StandardCharsets.UTF_8)));
            assertNotNull("price field should be at acme::commerce::price",
                rtLoader.getRoot().getChildOfType("field", "acme::commerce::price"));
        } finally {
            Files.deleteIfExists(src);
        }
    }

    /**
     * When the source file declares no package, the canonical output must have no
     * root {@code "package"} key.
     *
     * <p><strong>Known model quirk:</strong> {@code MetaRoot} cannot have a truly
     * empty name — {@code MetaDataLoader.sanitizeRootName("")} returns {@code "root"},
     * which {@link com.metaobjects.io.json.CanonicalJsonSerializer} would emit as
     * {@code "package": "root"}. {@link LegacyMetadataConverter} post-processes this
     * artefact away so that no root {@code package} key appears for package-less files.
     * If this assertion ever fails it means the strip logic broke, not that the model
     * was fixed (which would make the test vacuous but still correct).</p>
     */
    @Test
    public void noPackageFileProducesNoRootPackageKey() throws Exception {
        // Declare no package at all
        String naturalJson =
            "{ \"metadata\": { \"children\": [\n" +
            "  { \"field\": { \"name\": \"genericId\", \"subType\": \"long\" } }\n" +
            "] } }";
        Path src = Files.createTempFile("legacy_nopkg", ".json");
        try {
            Files.writeString(src, naturalJson);

            String canonical = LegacyMetadataConverter.convertToCanonical(src);

            JsonObject canonicalRoot = JsonParser.parseString(canonical).getAsJsonObject();
            JsonObject rootBody = getMetadataRootBody(canonicalRoot);
            assertNotNull("canonical output must have a metadata.root body", rootBody);

            // The root body MUST NOT contain a "package" key.
            // (If the MetaRoot model is ever fixed to allow a truly empty name this test
            // will still pass, which is correct — we simply want no spurious package key.)
            assertFalse(
                "no-package file must not emit a root 'package' key (MetaRoot model quirk: " +
                "sanitizeRootName(\"\") returns 'root', which the converter strips post-hoc)",
                rootBody.has("package"));
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

    // -----------------------------------------------------------------------
    // Test helpers
    // -----------------------------------------------------------------------

    /**
     * Returns the body object inside the {@code "metadata.root"} wrapper, or
     * {@code null} if the structure is not as expected.
     */
    private JsonObject getMetadataRootBody(JsonObject canonicalRoot) {
        for (String key : canonicalRoot.keySet()) {
            if (key.startsWith("metadata.")) {
                JsonElement body = canonicalRoot.get(key);
                if (body != null && body.isJsonObject()) {
                    return body.getAsJsonObject();
                }
            }
        }
        return null;
    }

    /**
     * Asserts that no direct child node in the {@code "children"} array of
     * {@code rootBody} carries a {@code "package"} key equal to
     * {@code parentPackage} (which would be redundant — the serializer should
     * suppress package keys that match the parent's package).
     */
    private void assertNoRedundantPackageOnChildren(JsonObject rootBody, String parentPackage) {
        if (!rootBody.has("children")) return;
        JsonElement childrenEl = rootBody.get("children");
        if (!childrenEl.isJsonArray()) return;

        for (JsonElement childEl : childrenEl.getAsJsonArray()) {
            if (!childEl.isJsonObject()) continue;
            JsonObject childWrapper = childEl.getAsJsonObject();
            // Each child wrapper is { "type.subType": { body } }
            for (String typeKey : childWrapper.keySet()) {
                JsonElement bodyEl = childWrapper.get(typeKey);
                if (bodyEl == null || !bodyEl.isJsonObject()) continue;
                JsonObject body = bodyEl.getAsJsonObject();
                if (body.has("package")) {
                    String childPkg = body.get("package").getAsString();
                    assertNotEquals(
                        "Child node [" + typeKey + "] carries a redundant 'package' key " +
                        "equal to parent package '" + parentPackage + "'",
                        parentPackage, childPkg);
                }
            }
        }
    }
}
