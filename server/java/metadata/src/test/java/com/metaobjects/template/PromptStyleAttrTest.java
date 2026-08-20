package com.metaobjects.template;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Tests for the FR-010 {@code @promptStyle} attribute on {@code template.prompt}.
 *
 * <p>Registered in FR-010 Plan 3 Task 1; re-homed from {@code template.output} to
 * {@code template.prompt} by ADR-0052, which made a template subtype's axis DIRECTION.
 * {@code @promptStyle} governs a fragment that instructs an LLM how to format its reply,
 * so its old home — the subtype defined as "every rendered artifact other than an LLM
 * prompt" — was a contradiction visible in the attribute's own description.
 *
 * <p>Mirrors the {@code @format} validation pattern in
 * {@link TemplateValidationTest#rejectsUnknownFormatValue()}.
 *
 * <p>Rules verified:
 * <ol>
 *   <li>The {@link TemplateConstants#ATTR_PROMPT_STYLE} constant equals {@code "promptStyle"}.</li>
 *   <li>Valid values ({@code guide}, {@code inline}, {@code exampleOnly}) load without error.</li>
 *   <li>An out-of-set value (e.g. {@code "fancy"}) is REJECTED with
 *       {@link ErrorCode#ERR_BAD_ATTR_VALUE}.</li>
 *   <li>When {@code @promptStyle} is absent the accessor
 *       ({@link PromptTemplate#getPromptStyle()}) returns the default {@code "guide"}.</li>
 * </ol>
 */
public class PromptStyleAttrTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("PromptStyleAttrTest", Collections.emptyList());
    }

    /**
     * Build a minimal {@code template.prompt} JSON fixture with the given
     * {@code @promptStyle} value (or none if {@code promptStyleValue} is null).
     */
    private String outputTemplateJson(String promptStyleValue) {
        String styleAttr = promptStyleValue != null
            ? ", \"@promptStyle\": \"" + promptStyleValue + "\""
            : "";
        // A template.prompt requires @textRef (the renderable body) and @payloadRef, so
        // declare a minimal payload object.value "P" and reference it. @responseRef is
        // what makes the prompt carry the ADR-0052 inbound half at all, and it is the
        // only reason @promptStyle is meaningful here — so these fixtures declare it.
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
               "  { \"object.value\": { \"name\": \"P\", \"children\": [" +
               "      { \"field.string\": { \"name\": \"f\" } }" +
               "  ] } }," +
               "  { \"template.prompt\": { \"name\": \"T\", \"@textRef\": \"out/t\", \"@payloadRef\": \"P\"," +
               "      \"@responseRef\": \"P\"" + styleAttr + " } }" +
               "] } }";
    }

    private MetaDataLoader load(String json, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(json, id)));
        return loader;
    }

    // -----------------------------------------------------------------------
    // Test 1 — constant value
    // -----------------------------------------------------------------------

    @Test
    public void attrPromptStyleConstantHasExpectedValue() {
        assertEquals("ATTR_PROMPT_STYLE constant must equal \"promptStyle\"",
            "promptStyle", TemplateConstants.ATTR_PROMPT_STYLE);
    }

    // -----------------------------------------------------------------------
    // Test 2 — valid values accepted
    // -----------------------------------------------------------------------

    @Test
    public void promptStyleGuideLoadsOk() {
        // Must not throw
        load(outputTemplateJson("guide"), "prompt-style-guide.json");
    }

    @Test
    public void promptStyleInlineLoadsOk() {
        load(outputTemplateJson("inline"), "prompt-style-inline.json");
    }

    @Test
    public void promptStyleExampleOnlyLoadsOk() {
        load(outputTemplateJson("exampleOnly"), "prompt-style-example-only.json");
    }

    // -----------------------------------------------------------------------
    // Test 3 — out-of-set value rejected
    // -----------------------------------------------------------------------

    @Test
    public void rejectsUnknownPromptStyleValue() {
        String json = outputTemplateJson("fancy");
        try {
            load(json, "prompt-style-fancy.json");
            fail("Expected MetaDataException for unknown @promptStyle value 'fancy'");
        } catch (MetaDataException e) {
            boolean codeMatches = e.getCode()
                .map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE)
                .orElse(false);
            boolean messageMatches = e.getMessage() != null
                && e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue(
                "Exception must signal ERR_BAD_ATTR_VALUE (via code or message): "
                    + e.getMessage(),
                codeMatches || messageMatches);
        }
    }

    // -----------------------------------------------------------------------
    // Test 4 — default applies when attribute is absent
    // -----------------------------------------------------------------------

    @Test
    public void absentPromptStyleDefaultsToGuide() {
        MetaDataLoader loader = load(outputTemplateJson(null), "prompt-style-absent.json");

        // Locate the template node
        com.metaobjects.MetaData templateNode =
            loader.getRoot().getChildOfType(
                TemplateConstants.TYPE_TEMPLATE, "acme::T");
        assertNotNull("template.prompt 'T' must be present in the loaded root", templateNode);
        assertTrue("template node must be a PromptTemplate instance",
            templateNode instanceof PromptTemplate);

        PromptTemplate t = (PromptTemplate) templateNode;
        assertFalse("@promptStyle must not be set (absent in JSON)",
            t.hasMetaAttr(TemplateConstants.ATTR_PROMPT_STYLE, false));
        assertEquals("getPromptStyle() must return the default 'guide' when absent",
            TemplateConstants.PROMPT_STYLE_DEFAULT, t.getPromptStyle());
        assertEquals("PROMPT_STYLE_DEFAULT must equal \"guide\"",
            "guide", TemplateConstants.PROMPT_STYLE_DEFAULT);
    }

    // -----------------------------------------------------------------------
    // Test 5 — ADR-0053 @responseFormat, the sibling of @promptStyle
    // -----------------------------------------------------------------------

    @Test
    public void absentResponseFormatDefaultsToJson() {
        MetaDataLoader loader = load(outputTemplateJson(null), "response-format-absent.json");

        com.metaobjects.MetaData templateNode =
            loader.getRoot().getChildOfType(
                TemplateConstants.TYPE_TEMPLATE, "acme::T");
        PromptTemplate t = (PromptTemplate) templateNode;

        assertFalse("@responseFormat must not be set (absent in JSON)",
            t.hasMetaAttr(TemplateConstants.ATTR_RESPONSE_FORMAT, false));
        // The default reproduces the pre-ADR-0053 fallback exactly (anything that was
        // not "xml" was treated as JSON), so it is behaviour-preserving.
        assertEquals("getResponseFormat() must return the default 'json' when absent",
            TemplateConstants.RESPONSE_FORMAT_DEFAULT, t.getResponseFormat());
        assertEquals("RESPONSE_FORMAT_DEFAULT must equal \"json\"",
            "json", TemplateConstants.RESPONSE_FORMAT_DEFAULT);
    }

    @Test
    public void rejectsUnknownResponseFormatValue() {
        // "markdown" is a legal @format but NOT a legal @responseFormat — nothing
        // dispatches on it inbound (ADR-0053).
        String json = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
                      "  { \"object.value\": { \"name\": \"P\", \"children\": [" +
                      "      { \"field.string\": { \"name\": \"f\" } }" +
                      "  ] } }," +
                      "  { \"template.prompt\": { \"name\": \"T\", \"@textRef\": \"out/t\"," +
                      "      \"@payloadRef\": \"P\", \"@responseRef\": \"P\"," +
                      "      \"@responseFormat\": \"markdown\" } }" +
                      "] } }";
        try {
            load(json, "bad-response-format.json");
            fail("an out-of-set @responseFormat must be rejected");
        } catch (RuntimeException e) {
            boolean messageMatches = e.getMessage() != null
                && e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue(
                "Exception must signal ERR_BAD_ATTR_VALUE: " + e.getMessage(),
                messageMatches);
        }
    }
}
