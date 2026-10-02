package com.metaobjects.render.extract;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class ExtractTest {

    private ExtractSchema jsonAnswer() {
        return new ExtractSchema(Format.JSON, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true),
                FieldSpec.enumField("confidence", true, List.of("HIGH", "OK", "LOW"), Map.of("medium", "OK")),
                FieldSpec.scalar("note", FieldKind.STRING, false)));
    }

    @Test
    public void cleanJsonAllExtracted() {
        ExtractionOutcome o = Extract.extract(
                "{\"text\":\"hi\",\"confidence\":\"HIGH\",\"note\":\"n\"}", jsonAnswer(), ExtractOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals("HIGH", o.data().get("confidence"));
        assertEquals(FieldExtraction.EXTRACTED, o.report().states().get("confidence"));
        assertFalse(o.report().hasLostRequired());
    }

    @Test
    public void fencedAndProseWrappedStillExtracts() {
        String dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"HIGH\"}\n```\nDone.";
        ExtractionOutcome o = Extract.extract(dirty, jsonAnswer(), ExtractOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals(FieldExtraction.LOST_OPTIONAL, o.report().states().get("note"));
    }

    @Test
    public void aliasFoldsOffVocab() {
        ExtractionOutcome o = Extract.extract(
                "{\"text\":\"hi\",\"confidence\":\"medium\"}", jsonAnswer(), ExtractOptions.defaults());
        assertEquals("OK", o.data().get("confidence"));
        assertEquals(FieldExtraction.EXTRACTED, o.report().states().get("confidence"));
    }

    @Test
    public void offVocabRequiredIsMalformed() {
        ExtractionOutcome o = Extract.extract(
                "{\"text\":\"hi\",\"confidence\":\"banana\"}", jsonAnswer(), ExtractOptions.defaults());
        assertEquals(FieldExtraction.MALFORMED, o.report().states().get("confidence"));
        assertFalse(o.data().containsKey("confidence"));
    }

    @Test
    public void missingRequiredIsLostRequired() {
        ExtractionOutcome o = Extract.extract("{\"text\":\"hi\"}", jsonAnswer(), ExtractOptions.defaults());
        assertEquals(List.of("confidence"), o.report().lostRequired());
    }

    @Test
    public void emptyResponseFlagsEmptyAndAllRequiredLost() {
        ExtractionOutcome o = Extract.extract("   ", jsonAnswer(), ExtractOptions.defaults());
        assertTrue(o.report().isEmpty());
        assertTrue(o.report().lostRequired().contains("text"));
        assertTrue(o.report().lostRequired().contains("confidence"));
    }

    @Test
    public void xmlUnclosedTagExtracts() {
        ExtractSchema xml = new ExtractSchema(Format.XML, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true),
                FieldSpec.enumField("confidence", true, List.of("HIGH"), Map.of())));
        ExtractionOutcome o = Extract.extract("<answer><text>hi<confidence>HIGH</confidence></answer>",
                xml, ExtractOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals("HIGH", o.data().get("confidence"));
    }

    @Test
    public void neverThrowsOnGarbage() {
        ExtractionOutcome o = Extract.extract("@@@ totally broken @@@", jsonAnswer(), ExtractOptions.defaults());
        assertTrue(o.report().isEmpty());
    }

    // ---- #364: document-level onLocate hook ----

    @Test
    public void onLocateOverridesDefaultLocatorChoice() {
        String dirty = "```json\n{\"text\":\"draft\",\"confidence\":\"HIGH\"}\n```\n"
                + "Actually, here is the real answer:\n"
                + "```json\n{\"text\":\"final\",\"confidence\":\"HIGH\"}\n```";
        // The default locator would pick the FIRST fenced block (it already carries a declared
        // field, #363). This hook picks the LAST fenced block instead.
        ExtractOptions.OnLocate onLocate = (text, format) -> {
            assertEquals(Format.JSON, format);
            java.util.regex.Matcher m =
                    java.util.regex.Pattern.compile("```json\\s*\\n([\\s\\S]*?)\\n```").matcher(text);
            String last = null;
            while (m.find()) last = m.group(1);
            return last;
        };
        ExtractOptions opts = ExtractOptions.defaults().withOnLocate(onLocate);
        ExtractionOutcome o = Extract.extract(dirty, jsonAnswer(), opts);
        assertEquals("final", o.data().get("text"));
    }

    @Test
    public void onLocateNullFallsBackToDefaultLocator() {
        String dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"HIGH\"}\n```\nDone.";
        ExtractOptions opts = ExtractOptions.defaults().withOnLocate((text, format) -> null);
        ExtractionOutcome o = Extract.extract(dirty, jsonAnswer(), opts);
        assertEquals("hi", o.data().get("text"));
    }

    @Test
    public void onLocateIsAuditedAsOnLocateCoercionOnDocumentPath() {
        String located = "{\"text\":\"hi\",\"confidence\":\"HIGH\"}";
        ExtractOptions opts = ExtractOptions.defaults().withOnLocate((text, format) -> located);
        ExtractionOutcome o = Extract.extract("noise before " + located + " noise after", jsonAnswer(), opts);
        Coercion entry = o.report().coercions().stream()
                .filter(c -> "onLocate".equals(c.kind()))
                .findFirst()
                .orElse(null);
        assertNotNull(entry);
        assertEquals("", entry.fieldPath());
        assertEquals(String.valueOf(located.length()), entry.to());
    }

    @Test
    public void onLocatedTextStillRunsThroughNormalPipeline() {
        ExtractOptions opts = ExtractOptions.defaults()
                .withOnLocate((text, format) -> "{\"text\":\"hi\",\"confidence\":\"medium\"}");
        ExtractionOutcome o = Extract.extract("ignored prose", jsonAnswer(), opts);
        // jsonAnswer()'s confidence field declares @enumAlias medium -> OK.
        assertEquals("OK", o.data().get("confidence"));
        assertEquals(FieldExtraction.EXTRACTED, o.report().states().get("confidence"));
    }

    @Test
    public void onLocateEmptySpanReportsEmptyLikeAnEmptyReply() {
        // The ORIGINAL reply is non-blank — only onLocate's chosen region is empty. The empty
        // flag must key off what onLocate selected, not off the original text.
        ExtractOptions opts = ExtractOptions.defaults().withOnLocate((text, format) -> "");
        ExtractionOutcome o = Extract.extract("some reply text that is not empty", jsonAnswer(), opts);
        assertTrue(o.report().isEmpty());
        assertTrue(o.report().lostRequired().contains("text"));
        assertTrue(o.report().lostRequired().contains("confidence"));
    }

    @Test
    public void onLocateThrowingPropagates() {
        ExtractOptions opts = ExtractOptions.defaults().withOnLocate((text, format) -> {
            throw new RuntimeException("boom");
        });
        try {
            Extract.extract("anything", jsonAnswer(), opts);
            fail("expected RuntimeException to propagate");
        } catch (RuntimeException e) {
            assertEquals("boom", e.getMessage());
        }
    }

    @Test
    public void onLocateDrivesXmlExtractionWithXmlFormat() {
        ExtractSchema xml = new ExtractSchema(Format.XML, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true)));
        java.util.concurrent.atomic.AtomicReference<Format> seen = new java.util.concurrent.atomic.AtomicReference<>();
        ExtractOptions opts = ExtractOptions.defaults().withOnLocate((text, format) -> {
            seen.set(format);
            java.util.regex.Matcher m =
                    java.util.regex.Pattern.compile("<answer>[\\s\\S]*</answer>").matcher(text);
            return m.find() ? m.group() : null;
        });
        ExtractionOutcome o = Extract.extract(
                "prose <wrapper><answer><text>hi</text></answer></wrapper> trailing", xml, opts);
        assertEquals(Format.XML, seen.get());
        assertEquals("hi", o.data().get("text"));
    }

    @Test
    public void onLocateMaySynthesizeTextNotInInput() {
        ExtractOptions opts = ExtractOptions.defaults()
                .withOnLocate((text, format) -> "{\"text\":\"synthesized\",\"confidence\":\"HIGH\"}");
        ExtractionOutcome o = Extract.extract("totally unrelated noise", jsonAnswer(), opts);
        assertEquals("synthesized", o.data().get("text"));
    }

    @Test
    public void jsonStringArrayExtractsAsList() {
        ExtractSchema s = new ExtractSchema(Format.JSON, "answer", List.of(
                new FieldSpec("tags", FieldKind.STRING, false, true, null, null, null, null, null,
                        null, null, Normalize.DEFAULT, false)));
        ExtractionOutcome o = Extract.extract("{\"tags\":[\"a\",\"b\"]}", s, ExtractOptions.defaults());
        assertEquals(List.of("a", "b"), o.data().get("tags"));
        assertEquals(FieldExtraction.EXTRACTED, o.report().states().get("tags"));
    }

    @Test
    public void jsonEnumArrayCoercesPerElement() {
        ExtractSchema s = new ExtractSchema(Format.JSON, "answer", List.of(
                new FieldSpec("tones", FieldKind.ENUM, false, true,
                        List.of("HIGH", "LOW"), Map.of("warm", "HIGH"), null, null, null,
                        null, null, Normalize.DEFAULT, false)));
        ExtractionOutcome o = Extract.extract("{\"tones\":[\"warm\",\"LOW\"]}", s, ExtractOptions.defaults());
        assertEquals(List.of("HIGH", "LOW"), o.data().get("tones"));
        assertEquals(FieldExtraction.EXTRACTED, o.report().states().get("tones"));
    }

    @Test
    public void listForScalarFieldIsMalformed() {
        ExtractSchema s = new ExtractSchema(Format.JSON, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true)));
        ExtractionOutcome o = Extract.extract("{\"text\":[\"a\",\"b\"]}", s, ExtractOptions.defaults());
        assertEquals(FieldExtraction.MALFORMED, o.report().states().get("text"));
        assertFalse(o.data().containsKey("text"));
    }

    @Test
    public void objectFieldWithScalarValueIsMalformed() {
        ExtractSchema nested = new ExtractSchema(Format.JSON, "meta",
                List.of(FieldSpec.scalar("n", FieldKind.STRING, true)));
        ExtractSchema s = new ExtractSchema(Format.JSON, "answer", List.of(
                FieldSpec.object("meta", true, false, nested)));
        ExtractionOutcome o = Extract.extract("{\"meta\":\"oops\"}", s, ExtractOptions.defaults());
        assertEquals(FieldExtraction.MALFORMED, o.report().states().get("meta"));
    }

    @Test
    public void truncatedValueIsMalformedNotLost() {
        // confidence key present but value cut off → MALFORMED (present-but-garbled), distinct from absent
        ExtractionOutcome o = Extract.extract("{\"text\":\"hi\",\"confidence\":", jsonAnswer(), ExtractOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals(FieldExtraction.MALFORMED, o.report().states().get("confidence"));
        assertFalse(o.report().isEmpty());
    }

    @Test
    public void partialEnumArrayIsMalformedButKeepsValidElements() {
        ExtractSchema s = new ExtractSchema(Format.JSON, "answer", List.of(
                new FieldSpec("tones", FieldKind.ENUM, false, true,
                        List.of("HIGH", "LOW"), Map.of(), null, null, null,
                        null, null, Normalize.DEFAULT, false)));
        ExtractionOutcome o = Extract.extract("{\"tones\":[\"HIGH\",\"grape\"]}", s, ExtractOptions.defaults());
        assertEquals(FieldExtraction.MALFORMED, o.report().states().get("tones"));
        assertEquals(List.of("HIGH"), o.data().get("tones"));   // valid element retained
    }
}
