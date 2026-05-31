package com.metaobjects.render.prompt;

import com.metaobjects.render.extract.Format;
import com.metaobjects.render.extract.FieldKind;
import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class OutputFormatSpecModelTest {
    @Test public void buildsSpec() {
        PromptField f = new PromptField("confidence", FieldKind.ENUM, true, false,
                List.of("HIGH","LOW"), Map.of("HIGH","Directly supported."),
                "HIGH", "Pick one.", null);
        OutputFormatSpec s = new OutputFormatSpec(Format.XML, "Answer", PromptStyle.GUIDE, List.of(f));
        assertEquals(PromptStyle.GUIDE, s.style());
        assertEquals("Directly supported.", s.fields().get(0).enumDoc().get("HIGH"));
    }
    @Test public void overridesDefaultsEmpty() {
        PromptOverrides o = PromptOverrides.none();
        assertNull(o.style());
        assertTrue(o.examples().isEmpty());
        assertTrue(o.instructions().isEmpty());
    }
    @Test public void styleFromString() {
        assertEquals(PromptStyle.INLINE, PromptStyle.from("inline"));
        assertEquals(PromptStyle.EXAMPLE_ONLY, PromptStyle.from("exampleOnly"));
        assertEquals(PromptStyle.GUIDE, PromptStyle.from(null));
        assertEquals(PromptStyle.GUIDE, PromptStyle.from("whatever"));
    }
}
