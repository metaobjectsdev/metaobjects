package com.metaobjects.render.prompt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.render.extract.Format;
import com.metaobjects.render.extract.FieldKind;
import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class OutputFormatRendererInlineTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private OutputFormatSpec spec(Format f) {
        return new OutputFormatSpec(f, "Answer", PromptStyle.INLINE, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null, null, "one sentence", null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH","OK","LOW"), null, null, null, null)));
    }
    @Test public void xmlInlineChoicesNoComments() {
        String out = OutputFormatRenderer.render(spec(Format.XML), PromptOverrides.none());
        assertFalse(out.contains("<!--"));
        assertTrue(out.contains("<confidence>HIGH | OK | LOW</confidence>"));
        assertTrue(out.contains("<text>"));
        assertTrue(out.contains("</Answer>"));
    }
    @Test public void jsonInlineStillValid() throws Exception {
        String out = OutputFormatRenderer.render(spec(Format.JSON), PromptOverrides.none());
        String json = out.substring(out.indexOf('{'), out.lastIndexOf('}') + 1);
        assertEquals("HIGH | OK | LOW", JSON.readTree(json).get("confidence").asText());
    }
}
