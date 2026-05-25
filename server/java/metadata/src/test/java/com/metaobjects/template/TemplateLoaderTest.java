package com.metaobjects.template;

import com.metaobjects.MetaData;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Load + round-trip + typed-accessor coverage for the {@code template.*} metatype.
 *
 * <p>Mirrors the structure of the conformance fixtures under
 * {@code fixtures/conformance/template-output-simple} and {@code template-prompt-simple}
 * — but exercised through the loader pipeline (parse → ValidationPhase →
 * CanonicalJsonSerializer) as a standalone unit test so a failure here points at
 * Java port code directly without needing the cross-language fixture harness.</p>
 */
public class TemplateLoaderTest extends SharedRegistryTestBase {

    private static final String OUTPUT_FIXTURE =
        "{ \"metadata.root\": { \"package\": \"acme::ai\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"PayloadVo\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"name\" } }" +
        "  ] } }," +
        "  { \"template.output\": { \"name\": \"OutTmpl\"," +
        "      \"@payloadRef\": \"PayloadVo\"," +
        "      \"@textRef\": \"ai/output\"," +
        "      \"@format\": \"json\" } }" +
        "] } }";

    private static final String PROMPT_FIXTURE =
        "{ \"metadata.root\": { \"package\": \"acme::ai\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"PromptVo\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"q\" } }" +
        "  ] } }," +
        "  { \"template.prompt\": { \"name\": \"PromptTmpl\"," +
        "      \"@payloadRef\": \"PromptVo\"," +
        "      \"@textRef\": \"ai/prompt\"," +
        "      \"@maxTokens\": 1024," +
        "      \"@requiredSlots\": [ \"q\" ]," +
        "      \"@model\": \"claude-opus-4-7\" } }" +
        "] } }";

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = createTestLoader("TemplateLoaderTest", Collections.emptyList());
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    @Test
    public void outputTemplateLoadsAndRoundTrips() {
        MetaDataLoader loader = loadThrough(OUTPUT_FIXTURE, "out.json");

        MetaData out = loader.getRoot().getChildOfType(
            TemplateConstants.TYPE_TEMPLATE, "acme::ai::OutTmpl");
        assertNotNull("template.output node should load", out);
        assertEquals(TemplateConstants.SUBTYPE_OUTPUT, out.getSubType());
        assertTrue("expected OutputTemplate instance", out instanceof OutputTemplate);

        String json = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("expected template.output key in canonical output",
            json.contains("\"template.output\""));
        assertTrue("expected @payloadRef in canonical output",
            json.contains("\"@payloadRef\""));
        assertTrue("expected @textRef in canonical output",
            json.contains("\"@textRef\""));
        assertTrue("expected @format: json in canonical output",
            json.contains("\"@format\": \"json\""));
    }

    @Test
    public void promptTemplateLoadsAndExposesTypedAttrs() {
        MetaDataLoader loader = loadThrough(PROMPT_FIXTURE, "prompt.json");

        MetaData node = loader.getRoot().getChildOfType(
            TemplateConstants.TYPE_TEMPLATE, "acme::ai::PromptTmpl");
        assertNotNull("template.prompt node should load", node);
        assertTrue("expected PromptTemplate instance", node instanceof PromptTemplate);

        PromptTemplate p = (PromptTemplate) node;
        assertEquals("PromptVo", p.getPayloadRef());
        assertEquals("ai/prompt", p.getTextRef());
        // @format is not set in PROMPT_FIXTURE → the default ("text") applies.
        assertEquals(TemplateConstants.FORMAT_DEFAULT, p.getFormat());

        List<String> slots = p.getRequiredSlots();
        assertNotNull("@requiredSlots should be populated", slots);
        assertEquals(1, slots.size());
        assertEquals("q", slots.get(0));
    }
}
