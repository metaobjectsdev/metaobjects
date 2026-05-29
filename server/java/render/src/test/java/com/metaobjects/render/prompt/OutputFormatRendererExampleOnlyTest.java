package com.metaobjects.render.prompt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.FieldKind;
import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class OutputFormatRendererExampleOnlyTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private OutputFormatSpec spec(Format fmt) {
        return new OutputFormatSpec(fmt, "Answer", PromptStyle.EXAMPLE_ONLY, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null, "hello", null, null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH","LOW"), null, "HIGH", null, null)));
    }

    @Test public void xmlIsWellFormedAndCommentFree() {
        String out = OutputFormatRenderer.render(spec(Format.XML), PromptOverrides.none());
        assertFalse("no XML comments", out.contains("<!--"));
        assertTrue(out.contains("<Answer>"));
        assertTrue(out.contains("<text>hello</text>"));
        assertTrue(out.contains("<confidence>HIGH</confidence>"));
        assertTrue(out.contains("</Answer>"));
    }

    @Test public void jsonExampleBlockIsValidJson() throws Exception {
        String out = OutputFormatRenderer.render(spec(Format.JSON), PromptOverrides.none());
        int open = out.indexOf('{'), close = out.lastIndexOf('}');
        String json = out.substring(open, close + 1);
        var node = JSON.readTree(json);
        assertEquals("hello", node.get("text").asText());
        assertEquals("HIGH", node.get("confidence").asText());
    }

    @Test public void exampleOverrideWins() {
        PromptOverrides ov = new PromptOverrides(null, Map.of("text", "OVERRIDDEN"), Map.of());
        String out = OutputFormatRenderer.render(spec(Format.XML), ov);
        assertTrue(out.contains("<text>OVERRIDDEN</text>"));
    }

    @Test public void nanDoubleStaysValidJsonQuoted() throws Exception {
        OutputFormatSpec s = new OutputFormatSpec(Format.JSON, "Answer", PromptStyle.EXAMPLE_ONLY, List.of(
            new PromptField("score", FieldKind.DOUBLE, true, false, null, null, "NaN", null, null)));
        String out = OutputFormatRenderer.render(s, PromptOverrides.none());
        String json = out.substring(out.indexOf('{'), out.lastIndexOf('}') + 1);
        assertEquals("NaN", JSON.readTree(json).get("score").asText());  // quoted string, valid JSON
    }

    @Test public void urlValueDoesNotBreakJson() throws Exception {
        OutputFormatSpec s = new OutputFormatSpec(Format.JSON, "Answer", PromptStyle.EXAMPLE_ONLY, List.of(
            new PromptField("link", FieldKind.STRING, true, false, null, null, "https://example.com/x", null, null)));
        String out = OutputFormatRenderer.render(s, PromptOverrides.none());
        String json = out.substring(out.indexOf('{'), out.lastIndexOf('}') + 1);
        assertEquals("https://example.com/x", JSON.readTree(json).get("link").asText());
    }

    @Test public void jsonValueWithQuotesStaysValid() throws Exception {
        OutputFormatSpec s = new OutputFormatSpec(Format.JSON, "Answer", PromptStyle.EXAMPLE_ONLY, List.of(
            new PromptField("q", FieldKind.STRING, true, false, null, null, "she said \"hi\"", null, null)));
        String out = OutputFormatRenderer.render(s, PromptOverrides.none());
        String json = out.substring(out.indexOf('{'), out.lastIndexOf('}') + 1);
        assertEquals("she said \"hi\"", JSON.readTree(json).get("q").asText());
    }
}
