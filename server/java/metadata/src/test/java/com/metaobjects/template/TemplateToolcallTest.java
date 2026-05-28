package com.metaobjects.template;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.registry.TypeDefinition;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Unit tests for {@code template.toolcall} — the third core template subtype
 * shipped in {@code 0.7.0-rc.7} per ADR-0011, mirroring the TS port's rc.5
 * delivery.
 *
 * <p>Toolcall is a sibling of {@link PromptTemplate} and {@link OutputTemplate}
 * but does NOT inherit the generic {@code @payloadRef} / {@code @textRef} /
 * {@code @format} attrs — it declares its own minimal set ({@code @toolName}
 * required + {@code @payloadRef} required + governance {@code @owner} /
 * {@code @since}). No {@code @textRef} requirement because a tool-call has no
 * renderable text body; the body IS the structured output schema resolved via
 * {@code @payloadRef}.
 *
 * <p>Vendor wire details (Anthropic's retry-with-reminder, OpenAI's function-
 * calling envelope, MCP's tool definitions, etc.) are NOT in core. Consumers
 * add vendor specifics via a project-local provider that registers additional
 * attrs on this subtype.
 */
public class TemplateToolcallTest extends SharedRegistryTestBase {

    // ---- registry shape ----------------------------------------------------

    @Test
    public void coreProviderRegistersTemplateToolcallSubtype() {
        MetaDataRegistry registry = MetaDataRegistry.getInstance();
        TypeDefinition def = registry.getTypeDefinition(
            TemplateConstants.TYPE_TEMPLATE, TemplateConstants.SUBTYPE_TOOLCALL);
        assertNotNull("template.toolcall should be registered by the template-types provider", def);
        assertEquals(ToolcallTemplate.class, def.getImplementationClass());
    }

    @Test
    public void templateSubtypeToolcallConstantMatches() {
        assertEquals("toolcall", TemplateConstants.SUBTYPE_TOOLCALL);
        assertEquals("toolName", TemplateConstants.ATTR_TOOL_NAME);
    }

    // ---- loader: positive + negative paths --------------------------------

    private static final String TOOLCALL_OK =
        "{ \"metadata.root\": { \"package\": \"acme::tools\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"WeatherToolOutput\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"summary\" } }," +
        "    { \"field.int\":    { \"name\": \"tempCelsius\" } }" +
        "  ] } }," +
        "  { \"template.toolcall\": {" +
        "      \"name\": \"lookupWeather\"," +
        "      \"@toolName\": \"lookup_weather\"," +
        "      \"@payloadRef\": \"WeatherToolOutput\"," +
        "      \"@owner\": \"tools-team\"," +
        "      \"@since\": \"0.7.0\" } }" +
        "] } }";

    private static final String TOOLCALL_MISSING_TOOL_NAME =
        "{ \"metadata.root\": { \"package\": \"acme::tools\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"Out\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"x\" } }" +
        "  ] } }," +
        "  { \"template.toolcall\": {" +
        "      \"name\": \"missingToolName\"," +
        "      \"@payloadRef\": \"Out\" } }" +
        "] } }";

    private static final String TOOLCALL_MISSING_PAYLOAD_REF =
        "{ \"metadata.root\": { \"package\": \"acme::tools\", \"children\": [" +
        "  { \"template.toolcall\": {" +
        "      \"name\": \"missingPayloadRef\"," +
        "      \"@toolName\": \"do_thing\" } }" +
        "] } }";

    private static final String TOOLCALL_BAD_PAYLOAD_REF =
        "{ \"metadata.root\": { \"package\": \"acme::tools\", \"children\": [" +
        "  { \"template.toolcall\": {" +
        "      \"name\": \"danglingPayload\"," +
        "      \"@toolName\": \"do_thing\"," +
        "      \"@payloadRef\": \"DoesNotExist\" } }" +
        "] } }";

    private MetaDataLoader newTestLoader() {
        return createTestLoader("TemplateToolcallTest", Collections.emptyList());
    }

    @Test
    public void toolcallLoadsWithRequiredAttrs() {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(TOOLCALL_OK, "toolcall-ok.json")));

        MetaData node = loader.getRoot().getChildOfType(
            TemplateConstants.TYPE_TEMPLATE, "acme::tools::lookupWeather");
        assertNotNull("template.toolcall node should load", node);
        assertEquals(TemplateConstants.SUBTYPE_TOOLCALL, node.getSubType());
        assertTrue("expected ToolcallTemplate instance", node instanceof ToolcallTemplate);

        ToolcallTemplate tc = (ToolcallTemplate) node;
        assertEquals("lookup_weather", tc.getToolName());
        assertEquals("WeatherToolOutput", tc.getPayloadRef());
        assertEquals("tools-team", tc.getOwner());
        assertEquals("0.7.0", tc.getSince());
    }

    @Test
    public void toolcallMissingToolNameRaisesMissingRequired() {
        try {
            newTestLoader().load(List.of(new InMemoryStringSource(
                TOOLCALL_MISSING_TOOL_NAME, "toolcall-missing-tool-name.json")));
            fail("expected MetaDataException for missing @toolName");
        } catch (MetaDataException ex) {
            assertEquals(ErrorCode.ERR_MISSING_REQUIRED_ATTR, ex.getCode().orElse(null));
            assertTrue("expected message to mention @toolName: " + ex.getMessage(),
                ex.getMessage().contains("@toolName"));
        }
    }

    @Test
    public void toolcallMissingPayloadRefRaisesMissingRequired() {
        try {
            newTestLoader().load(List.of(new InMemoryStringSource(
                TOOLCALL_MISSING_PAYLOAD_REF, "toolcall-missing-payload-ref.json")));
            fail("expected MetaDataException for missing @payloadRef");
        } catch (MetaDataException ex) {
            assertEquals(ErrorCode.ERR_MISSING_REQUIRED_ATTR, ex.getCode().orElse(null));
            assertTrue("expected message to mention @payloadRef: " + ex.getMessage(),
                ex.getMessage().contains("@payloadRef"));
        }
    }

    @Test
    public void toolcallBadPayloadRefRaisesInvalidTemplate() {
        // The shared @payloadRef must-resolve-to-root-level-object.value rule
        // applies to toolcall the same as prompt + output.
        try {
            newTestLoader().load(List.of(new InMemoryStringSource(
                TOOLCALL_BAD_PAYLOAD_REF, "toolcall-bad-payload-ref.json")));
            fail("expected MetaDataException for dangling @payloadRef");
        } catch (MetaDataException ex) {
            assertEquals(ErrorCode.ERR_INVALID_TEMPLATE, ex.getCode().orElse(null));
        }
    }
}
