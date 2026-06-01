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
 * Tests for the FR-010 {@code @promptStyle} attribute on {@code template.output}.
 *
 * <p>Registered in FR-010 Plan 3 Task 1. Mirrors the {@code @format} validation pattern
 * in {@link TemplateValidationTest#rejectsUnknownFormatValue()}.
 *
 * <p>Rules verified:
 * <ol>
 *   <li>The {@link TemplateConstants#ATTR_PROMPT_STYLE} constant equals {@code "promptStyle"}.</li>
 *   <li>Valid values ({@code guide}, {@code inline}, {@code exampleOnly}) load without error.</li>
 *   <li>An out-of-set value (e.g. {@code "fancy"}) is REJECTED with
 *       {@link ErrorCode#ERR_BAD_ATTR_VALUE}.</li>
 *   <li>When {@code @promptStyle} is absent the accessor
 *       ({@link OutputTemplate#getPromptStyle()}) returns the default {@code "guide"}.</li>
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
     * Build a minimal {@code template.output} JSON fixture with the given
     * {@code @promptStyle} value (or none if {@code promptStyleValue} is null).
     */
    private String outputTemplateJson(String promptStyleValue) {
        String styleAttr = promptStyleValue != null
            ? ", \"@promptStyle\": \"" + promptStyleValue + "\""
            : "";
        // A template.output defaults to @kind="document", which requires @textRef
        // (a document is never bodyless). Include it so these @promptStyle-focused
        // fixtures satisfy the document/textRef cross-field rule.
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
               "  { \"template.output\": { \"name\": \"T\", \"@textRef\": \"out/t\"" + styleAttr + " } }" +
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
        assertNotNull("template.output 'T' must be present in the loaded root", templateNode);
        assertTrue("template node must be an OutputTemplate instance",
            templateNode instanceof OutputTemplate);

        OutputTemplate t = (OutputTemplate) templateNode;
        assertFalse("@promptStyle must not be set (absent in JSON)",
            t.hasMetaAttr(TemplateConstants.ATTR_PROMPT_STYLE, false));
        assertEquals("getPromptStyle() must return the default 'guide' when absent",
            TemplateConstants.PROMPT_STYLE_DEFAULT, t.getPromptStyle());
        assertEquals("PROMPT_STYLE_DEFAULT must equal \"guide\"",
            "guide", TemplateConstants.PROMPT_STYLE_DEFAULT);
    }
}
