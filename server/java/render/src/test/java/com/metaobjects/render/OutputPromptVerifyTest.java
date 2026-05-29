package com.metaobjects.render;

import com.metaobjects.render.prompt.*;
import com.metaobjects.render.recover.*;
import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class OutputPromptVerifyTest {

    @Test public void coverageFlagsMissingRequiredField() {
        List<VerifyError> e = Verify.checkOutputPrompt("<Answer><text>hi</text></Answer>",
                List.of("text", "confidence"));
        assertEquals(1, e.size());
        assertEquals(Verify.ERR_OUTPUT_PROMPT_FIELD_MISSING, e.get(0).code());
        assertEquals("confidence", e.get(0).path());
    }

    @Test public void coverageAllPresentNoFindings() {
        List<VerifyError> e = Verify.checkOutputPrompt("<Answer><text>hi</text><confidence>HIGH</confidence></Answer>",
                List.of("text", "confidence"));
        assertTrue(e.isEmpty());
    }

    @Test public void roundTripExampleOnlyRecoversComplete() {
        // render the exampleOnly skeleton, then recover() it — required fields must all be present
        OutputFormatSpec spec = new OutputFormatSpec(Format.JSON, "Answer", PromptStyle.EXAMPLE_ONLY, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null, "hi", null, null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH"), null, "HIGH", null, null)));
        String fragment = OutputFormatRenderer.render(spec, PromptOverrides.none());
        String example = fragment.substring(fragment.indexOf('{'), fragment.lastIndexOf('}') + 1);

        RecoverSchema rs = new RecoverSchema(Format.JSON, "Answer", List.of(
            FieldSpec.scalar("text", FieldKind.STRING, true),
            FieldSpec.enumField("confidence", true, List.of("HIGH"), Map.of())));
        RecoverOutcome o = Recover.recover(example, rs, RecoverOptions.defaults());
        assertTrue("round-trip complete (no lostRequired): " + o.report().lostRequired(),
                o.report().lostRequired().isEmpty());
    }

    @Test public void roundTripXmlExampleOnly() {
        OutputFormatSpec spec = new OutputFormatSpec(Format.XML, "Answer", PromptStyle.EXAMPLE_ONLY, List.of(
            new PromptField("text", FieldKind.STRING, true, false, null, null, "hi", null, null),
            new PromptField("confidence", FieldKind.ENUM, true, false, List.of("HIGH"), null, "HIGH", null, null)));
        String fragment = OutputFormatRenderer.render(spec, PromptOverrides.none());
        RecoverSchema rs = new RecoverSchema(Format.XML, "Answer", List.of(
            FieldSpec.scalar("text", FieldKind.STRING, true),
            FieldSpec.enumField("confidence", true, List.of("HIGH"), Map.of())));
        RecoverOutcome o = Recover.recover(fragment, rs, RecoverOptions.defaults());
        assertTrue("xml round-trip complete: " + o.report().lostRequired(), o.report().lostRequired().isEmpty());
    }
}
