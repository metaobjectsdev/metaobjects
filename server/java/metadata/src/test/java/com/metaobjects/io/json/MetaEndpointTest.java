package com.metaobjects.io.json;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaRoot;
import com.metaobjects.conformance.CorpusRoot;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link MetaEndpoint} — the {@code GET /_meta} cross-port contract helper.
 *
 * <p>Uses the {@code extends-abstract-base} conformance fixture
 * ({@code fixtures/conformance/extends-abstract-base/input/meta.common.json}), which has
 * real OBJECT-level inheritance: {@code Subscriber extends acme::BaseEntity}, and
 * {@code BaseEntity} declares {@code createdAt}. That makes {@code canonicalSerialize}
 * (raw — Subscriber's own children only) and {@code canonicalSerializeEffective}
 * (Subscriber's children plus everything inherited from BaseEntity) genuinely different
 * documents, so equality against the effective form is a real discriminator rather than a
 * call-forwarding smoke test.
 */
public class MetaEndpointTest {

    @Test
    public void metaRoutePathIsTheCrossPortContractValue() {
        assertEquals("/_meta", MetaEndpoint.META_ROUTE_PATH);
    }

    @Test
    public void metaJsonReturnsTheEffectiveCanonicalSerialization() throws IOException {
        MetaRoot root = loadExtendsAbstractBaseFixture();

        String effective = CanonicalJsonSerializer.canonicalSerializeEffective(root);
        String raw = CanonicalJsonSerializer.canonicalSerialize(root);
        assertFalse("control: the fixture must actually exercise inheritance (raw must differ "
                + "from effective), otherwise this equality proves nothing",
            raw.equals(effective));

        assertEquals(effective, MetaEndpoint.metaJson(root));
    }

    /**
     * Structural discriminator that cannot be fooled by a substring match: the RAW
     * serialization ALSO contains the string "createdAt" (it's BaseEntity's own field),
     * so a naive {@code contains("createdAt")} check on the whole document would pass
     * even for a helper that (bug) called the raw serializer. This test instead locates
     * Subscriber's own "children" array specifically and checks THAT — true only for the
     * effective serialization.
     */
    @Test
    public void metaJsonSubscriberChildrenIncludeInheritedCreatedAt() throws IOException {
        MetaRoot root = loadExtendsAbstractBaseFixture();

        JsonObject effectiveSubscriber = findObjectByName(MetaEndpoint.metaJson(root), "Subscriber");
        assertTrue("effective Subscriber's own children must include the inherited 'createdAt' field",
            hasFieldNamed(effectiveSubscriber, "createdAt"));

        JsonObject rawSubscriber =
            findObjectByName(CanonicalJsonSerializer.canonicalSerialize(root), "Subscriber");
        assertFalse("raw Subscriber's own children must NOT include the inherited 'createdAt' field",
            hasFieldNamed(rawSubscriber, "createdAt"));
    }

    // -----------------------------------------------------------------------
    // Fixture loading — mirrors the established Java conformance idiom (see
    // conformance.StrictRunnerHardFailTest / object.ObjectModelConformanceTest): a fresh
    // manual-subtype MetaDataLoader fed the fixture's input file(s) via InMemoryStringSource.
    // -----------------------------------------------------------------------

    private static MetaRoot loadExtendsAbstractBaseFixture() throws IOException {
        Path inputDir = CorpusRoot.locate().resolve("extends-abstract-base").resolve("input");
        Path metaFile = inputDir.resolve("meta.common.json");
        String content = new String(Files.readAllBytes(metaFile), StandardCharsets.UTF_8);

        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "meta-endpoint-test");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(content, "meta.common.json")));

        assertTrue("fixture load must report no errors, got: " + loader.getErrors(),
            loader.getErrors().isEmpty());

        return loader.getRoot();
    }

    /** Finds the named {@code object.*} node anywhere in the document and returns its JSON body. */
    private static JsonObject findObjectByName(String json, String objectName) {
        JsonElement parsed = JsonParser.parseString(json);
        JsonArray topChildren = parsed.getAsJsonObject()
            .getAsJsonObject("metadata.root")
            .getAsJsonArray("children");
        for (JsonElement child : topChildren) {
            JsonObject wrapper = child.getAsJsonObject();
            for (String key : wrapper.keySet()) {
                if (!key.startsWith("object.")) continue;
                JsonObject obj = wrapper.getAsJsonObject(key);
                if (objectName.equals(obj.get("name").getAsString())) {
                    return obj;
                }
            }
        }
        throw new AssertionError("object '" + objectName + "' not found in: " + json);
    }

    /** True when the given {@code object.*} body has a {@code field.*} child named {@code fieldName}. */
    private static boolean hasFieldNamed(JsonObject objectEntity, String fieldName) {
        JsonArray children = objectEntity.getAsJsonArray("children");
        if (children == null) return false;
        for (JsonElement child : children) {
            JsonObject wrapper = child.getAsJsonObject();
            for (String key : wrapper.keySet()) {
                if (!key.startsWith("field.")) continue;
                JsonObject field = wrapper.getAsJsonObject(key);
                if (fieldName.equals(field.get("name").getAsString())) {
                    return true;
                }
            }
        }
        return false;
    }
}
