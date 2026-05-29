package com.metaobjects.render.prompt;

import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.FieldKind;
import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class OutputFormatRendererGuideTest {
    private OutputFormatSpec spec() {
        return new OutputFormatSpec(Format.XML, "Answer", PromptStyle.GUIDE, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null,
                "Your refund will appear in 3-5 days.", "One or two sentences to the customer.", null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH","LOW"),
                Map.of("HIGH","Directly supported.","LOW","A guess."), "HIGH", null, null),
            new PromptField("note", FieldKind.STRING, false, false, null, null, null, null, null)));
    }

    @Test public void guideListsFieldsRequiredOptionalAndEnumDocsWithoutComments() {
        String out = OutputFormatRenderer.render(spec(), PromptOverrides.none());
        assertFalse(out.contains("<!--"));
        assertTrue(out.contains("text (required)"));
        assertTrue(out.contains("One or two sentences to the customer."));
        assertTrue(out.contains("confidence (required)"));
        assertTrue(out.contains("HIGH = Directly supported."));
        assertTrue(out.contains("LOW = A guess."));
        assertTrue(out.contains("note (optional)"));
        assertTrue(out.contains("Respond exactly like this:"));
        assertTrue(out.contains("<Answer>"));
        assertTrue(out.contains("<text>Your refund will appear in 3-5 days.</text>"));
        assertTrue(out.contains("<confidence>HIGH</confidence>"));
    }

    @Test public void instructionOverrideWins() {
        PromptOverrides ov = new PromptOverrides(null, Map.of(), Map.of("text", "NEW INSTRUCTION"));
        assertTrue(OutputFormatRenderer.render(spec(), ov).contains("NEW INSTRUCTION"));
    }

    @Test public void guideJsonSkeletonIsValidJson() throws Exception {
        com.fasterxml.jackson.databind.ObjectMapper m = new com.fasterxml.jackson.databind.ObjectMapper();
        OutputFormatSpec s = new OutputFormatSpec(Format.JSON, "Answer", PromptStyle.GUIDE, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null, "hi {now}", "say {x}", null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH","LOW"),
                Map.of("HIGH","Directly supported."), "HIGH", null, null)));
        String out = OutputFormatRenderer.render(s, PromptOverrides.none());
        String afterMarker = out.substring(out.indexOf("Respond exactly like this:"));
        String json = afterMarker.substring(afterMarker.indexOf('{'), afterMarker.lastIndexOf('}') + 1);
        var node = m.readTree(json);   // must parse even though prose above contains { } braces
        assertEquals("hi {now}", node.get("text").asText());
        assertEquals("HIGH", node.get("confidence").asText());
    }
}
