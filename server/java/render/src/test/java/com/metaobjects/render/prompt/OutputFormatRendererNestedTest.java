package com.metaobjects.render.prompt;

import com.metaobjects.render.extract.FieldKind;
import com.metaobjects.render.extract.Format;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * FR-012 nested-object + array prompt expansion. Proves the Java {@link OutputFormatRenderer}
 * recurses into OBJECT fields and arrays (matching the TS reference), and that the depth/cycle
 * guard falls back to a flat {@code "{name}"} placeholder without throwing or looping forever.
 */
public class OutputFormatRendererNestedTest {

    private static final PromptOverrides NONE = PromptOverrides.none();

    private static PromptField scalar(String name, FieldKind kind, String example, String instruction) {
        return new PromptField(name, kind, true, false, null, null, example, instruction, null);
    }

    private static PromptField object(String name, boolean array, OutputFormatSpec nested) {
        return new PromptField(name, FieldKind.OBJECT, true, array, null, null, null, null, nested);
    }

    private static OutputFormatSpec spec(Format fmt, String rootName, List<PromptField> fields) {
        return new OutputFormatSpec(fmt, rootName, PromptStyle.GUIDE, fields);
    }

    /** Review { summary, meta:{ score } } — proves a nested object expands. */
    private static OutputFormatSpec review(Format fmt) {
        return spec(fmt, "Review", List.of(
                scalar("summary", FieldKind.STRING, "Solid work overall.", "One sentence."),
                object("meta", false, spec(fmt, "Meta", List.of(
                        scalar("score", FieldKind.INT, "5", "1-5."))))));
    }

    private static String render(OutputFormatSpec spec, PromptStyle style) {
        return OutputFormatRenderer.render(spec, new PromptOverrides(style, null, null));
    }

    @Test
    public void nestedObjectExampleOnlyJson() {
        assertEquals(
                "{\n  \"summary\": \"Solid work overall.\",\n  \"meta\": {\n    \"score\": 5\n  }\n}",
                render(review(Format.JSON), PromptStyle.EXAMPLE_ONLY));
    }

    @Test
    public void nestedObjectExampleOnlyXml() {
        assertEquals(
                "<Review>\n  <summary>Solid work overall.</summary>\n  <meta>\n    <score>5</score>\n  </meta>\n</Review>",
                render(review(Format.XML), PromptStyle.EXAMPLE_ONLY));
    }

    @Test
    public void nestedObjectInlineJson() {
        assertEquals(
                "{\n  \"summary\": \"{One sentence.}\",\n  \"meta\": {\n    \"score\": \"{1-5.}\"\n  }\n}",
                render(review(Format.JSON), PromptStyle.INLINE));
    }

    @Test
    public void nestedObjectGuideJson() {
        assertEquals(
                "Fill in each field as described below:\n"
                        + "- summary (required): One sentence.\n    e.g. Solid work overall.\n"
                        + "- meta (required)\n"
                        + "- meta.score (required): 1-5.\n    e.g. 5\n"
                        + "\nRespond exactly like this:\n"
                        + "{\n  \"summary\": \"Solid work overall.\",\n  \"meta\": {\n    \"score\": 5\n  }\n}",
                render(review(Format.JSON), PromptStyle.GUIDE));
    }

    @Test
    public void arrayOfObjectsExampleOnlyJson() {
        OutputFormatSpec s = spec(Format.JSON, "Bundle", List.of(
                object("items", true, spec(Format.JSON, "Item", List.of(
                        scalar("label", FieldKind.STRING, "spec", null))))));
        assertEquals(
                "{\n  \"items\": [\n    {\n      \"label\": \"spec\"\n    }\n  ]\n}",
                render(s, PromptStyle.EXAMPLE_ONLY));
    }

    @Test
    public void scalarArrayExampleOnlyJson() {
        PromptField tags = new PromptField("tags", FieldKind.STRING, true, true, null, null, null, null, null);
        OutputFormatSpec s = spec(Format.JSON, "Tagging", List.of(tags));
        assertEquals(
                "{\n  \"tags\": [\n    \"{tags}\"\n  ]\n}",
                render(s, PromptStyle.EXAMPLE_ONLY));
    }

    /**
     * A 12-deep chain of nested OBJECT specs exceeds MAX_NEST_DEPTH (8). The over-deep boundary
     * field must fall back to the flat {@code "child": "{child}"} placeholder, and rendering must
     * complete (no throw, no infinite loop).
     */
    @Test
    public void depthGuardFallsBackToFlatPlaceholder() {
        OutputFormatSpec leaf = spec(Format.JSON, "L", List.of(
                scalar("v", FieldKind.STRING, "x", null)));
        for (int i = 0; i < 12; i++) {
            leaf = spec(Format.JSON, "N" + i, List.of(object("child", false, leaf)));
        }
        String out = render(leaf, PromptStyle.EXAMPLE_ONLY);
        assertNotNull(out);
        assertTrue("expected a flat \"child\": \"{child}\" placeholder at the depth boundary, got:\n" + out,
                out.contains("\"child\": \"{child}\""));
    }
}
