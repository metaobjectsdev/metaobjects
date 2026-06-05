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
